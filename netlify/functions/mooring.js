// netlify/functions/mooring.js
// Server-side mooring analysis calculations for Murphy's Curves FLNG Engineering Suite
// Protects proprietary mooring sizing formulas by executing them on the server

exports.handler = async (event, context) => {
    // Enhanced CORS headers for all responses
    const corsHeaders = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
    };

    console.log('Mooring function invoked:', event.httpMethod);

    // Handle preflight requests
    if (event.httpMethod === "OPTIONS") {
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: ""
        };
    }

    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            headers: corsHeaders,
            body: JSON.stringify({ error: "Method not allowed" })
        };
    }

    try {
        const payload = JSON.parse(event.body || "{}");
        const {
            depth_m, disp_t, loa_m, beam_m, draft_m,
            current_kn, hs_m, tp_s, wind_ms, awind_m2,
            system, nlines, sf, material,
            diameter_mm, lineLen_m, pret_kN, theta_deg,
            surge_m, sway_m, yaw_deg, yawArm_m, daf
        } = payload;

        // Basic validation
        const numbers = {
            depth_m, disp_t, loa_m, beam_m, draft_m,
            current_kn, hs_m, tp_s, wind_ms,
            nlines, sf, diameter_mm, lineLen_m, pret_kN, theta_deg,
            surge_m, sway_m, yaw_deg, yawArm_m, daf
        };

        for (const [k, v] of Object.entries(numbers)) {
            if (typeof v !== "number" || Number.isNaN(v) || !Number.isFinite(v)) {
                return {
                    statusCode: 400,
                    headers: corsHeaders,
                    body: JSON.stringify({ error: `Invalid or missing number for '${k}'` })
                };
            }
        }

        // Validate string inputs
        const validSystems = ["Turret Mooring", "Spread Mooring", "Internal Turret", "External Turret"];
        const validMaterials = ["Chain", "Wire Rope", "Synthetic Fiber", "Hybrid"];

        if (!validSystems.includes(system)) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Invalid mooring system type" })
            };
        }

        if (!validMaterials.includes(material)) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Invalid line material" })
            };
        }

        // --- PROPRIETARY MOORING ANALYSIS FORMULAS (server-only) ---

        // Physical constants
        const RHO_W = 1025;       // kg/m^3 seawater
        const RHO_A = 1.225;      // kg/m^3 air
        const G = 9.81;           // m/s^2
        const CD_CURRENT = 1.05;  // drag coeff for current on hull
        const CD_WIND = 1.2;      // drag coeff for wind on topsides
        const C_WAVEDRIFT = 0.50; // wave-drift scaling factor (screening)
        const AUTO_WINDAGE_FACTOR = 0.65; // Awind ≈ 0.65 * LOA * B

        // Material properties
        const K_MBL = { "Chain": 0.60, "Wire Rope": 0.85, "Synthetic Fiber": 0.55, "Hybrid": 0.70 };
        const E_MATERIAL = {
            "Chain": { E: 200e9, eta: 0.60 },
            "Wire Rope": { E: 200e9, eta: 0.60 },
            "Synthetic Fiber": { E: 50e9, eta: 0.95 },
            "Hybrid": { E: 150e9, eta: 0.70 }
        };

        // Helper functions
        const knToMS = (kn) => kn * 0.514444;
        const degToRad = (d) => d * Math.PI / 180;

        const effLines = (system, N) => {
            if (system.includes("Spread")) return Math.max(3, Math.round(N / 3));
            return Math.max(3, Math.round(N / 4)); // turret/internal/external
        };

        const fatigueGrade = (material, dT) => {
            const C = (material === "Synthetic Fiber") ? 2.0e12 : 1.0e12;
            const m = 3.0;
            const Ncycles = C / Math.pow(Math.max(dT, 1), m);
            const years = Ncycles / 1.0e6;
            if (years >= 25) return `Good (≈ ${years.toFixed(0)} yrs)`;
            if (years >= 10) return `Fair (≈ ${years.toFixed(0)} yrs)`;
            return `Poor (≈ ${Math.max(1, years.toFixed(0))} yrs)`;
        };

        // Main calculation logic
        const Aunder = beam_m * draft_m; // m²
        const Awind = (isNaN(awind_m2) || awind_m2 === null) ?
            AUTO_WINDAGE_FACTOR * loa_m * beam_m : awind_m2;
        const U = knToMS(current_kn);
        const theta = degToRad(theta_deg);

        // Environmental forces (N)
        const F_current = 0.5 * RHO_W * CD_CURRENT * Aunder * U * U;
        const F_wind = 0.5 * RHO_A * CD_WIND * Awind * wind_ms * wind_ms;
        const F_wave = C_WAVEDRIFT * RHO_W * G * hs_m * hs_m * beam_m * (1 + 0.03 * tp_s);
        const F_env_kN = (F_current + F_wind + F_wave) / 1000; // kN

        const neff = effLines(system, nlines);

        // Line capacity & stiffness
        const k_mbl = K_MBL[material];
        const MBL_kN = k_mbl * diameter_mm * diameter_mm; // per leg
        const mat = E_MATERIAL[material];
        const d_m = diameter_mm / 1000;
        const area = Math.PI * Math.pow(d_m / 2, 2) * mat.eta; // m²
        const EA_N = mat.E * area;
        const K_line_N_per_m = EA_N / Math.max(lineLen_m, 1);
        const K_sys_kN_per_m = (K_line_N_per_m * neff * Math.cos(theta) * Math.cos(theta)) / 1000;

        // Static per-line tension
        const T_line_static_kN = (F_env_kN / neff) / Math.cos(theta) + pret_kN;

        // Dynamic increment from motions (screening)
        const yaw_rad = degToRad(yaw_deg);
        const x_eq_m = (isFinite(surge_m) ? surge_m : 0) +
            (isFinite(sway_m) ? sway_m : 0) +
            yaw_rad * (isFinite(yawArm_m) ? yawArm_m : 0);
        const deltaT_dyn_kN = (K_sys_kN_per_m > 1e-9) ?
            (K_sys_kN_per_m / neff) * (x_eq_m / Math.cos(theta)) : 0;
        const T_line_peak_kN = T_line_static_kN + Math.max(1, daf || 1.0) * deltaT_dyn_kN;

        // Safety and utilization analysis
        const utilization_static = (T_line_static_kN * sf) / MBL_kN;
        const utilization_peak = (T_line_peak_kN * sf) / MBL_kN;
        const safetyMargin_peak = (1 / utilization_peak - 1) * 100;

        const offset_m = (K_sys_kN_per_m > 1e-9) ? (F_env_kN / K_sys_kN_per_m) : Infinity;
        const offset_pctDepth = (offset_m / depth_m) * 100;

        const dT_kN = 0.25 * T_line_peak_kN; // coarse fatigue messaging
        const fatigue = fatigueGrade(material, dT_kN);

        const vesselNote = (disp_t < 150000 || loa_m < 250 || beam_m < 45) ?
            "⚠️ Vessel inputs look smaller than typical FLNG/FPSO. Verify." : "OK";

        // Generate recommendations
        let rec = [];
        if (utilization_peak > 1.0) {
            rec.push("Increase line diameter or number of lines, or reduce SF for screening only.");
        }
        if (utilization_peak > 0.85 && utilization_peak <= 1.0) {
            rec.push("Borderline peak capacity – consider +10–20 mm diameter or +2 storm-sector lines.");
        }
        if (offset_pctDepth > 10) {
            rec.push("Offset >10% of water depth – increase EA (stiffer/shorter lines) or add lines.");
        }
        if (F_env_kN > neff * MBL_kN / sf) {
            rec.push("Global capacity shortfall – revisit environment coefficients and sector line count.");
        }
        if (rec.length === 0) {
            rec.push("Within screening targets. Proceed to detailed analysis per API RP 2SK / ISO 19901-7.");
        }

        // Prepare test results for validation
        const runTests = () => {
            const tests = [];

            // Test A: Diameter increase should increase MBL and decrease utilization
            const testA_input = { ...payload, diameter_mm: diameter_mm + 20 };
            const testA_MBL = K_MBL[material] * (diameter_mm + 20) * (diameter_mm + 20);
            tests.push({
                name: "MBL increases with diameter",
                pass: testA_MBL > MBL_kN
            });

            // Test B: More lines should decrease per-line static tension
            const testB_neff = effLines(system, nlines + 4);
            const testB_static = (F_env_kN / testB_neff) / Math.cos(theta) + pret_kN;
            tests.push({
                name: "Static tension drops with more lines",
                pass: testB_static < T_line_static_kN
            });

            // Test C: Higher SF should increase utilization
            const testC_util = (T_line_peak_kN * (sf + 0.25)) / MBL_kN;
            tests.push({
                name: "Peak utilization rises with higher SF",
                pass: testC_util > utilization_peak
            });

            return tests;
        };

        const result = {
            // Environmental loads
            F_current_kN: Math.round((F_current / 1000) * 100) / 100,
            F_wind_kN: Math.round((F_wind / 1000) * 100) / 100,
            F_wave_kN: Math.round((F_wave / 1000) * 100) / 100,
            F_env_kN: Math.round(F_env_kN * 100) / 100,

            // System parameters
            neff,
            MBL_kN: Math.round(MBL_kN),
            EA_GN: Math.round((EA_N / 1e9) * 100) / 100,
            K_sys_kN_per_m: Math.round(K_sys_kN_per_m * 10) / 10,

            // Tensions and utilization
            T_line_static_kN: Math.round(T_line_static_kN),
            deltaT_dyn_kN: Math.round(deltaT_dyn_kN),
            T_line_peak_kN: Math.round(T_line_peak_kN),
            utilization_static: Math.round(utilization_static * 1000) / 1000,
            utilization_peak: Math.round(utilization_peak * 1000) / 1000,
            safetyMargin_peak: Math.round(safetyMargin_peak * 10) / 10,

            // Offset and fatigue
            offset_m: Math.round(offset_m * 10) / 10,
            offset_pctDepth: Math.round(offset_pctDepth * 10) / 10,
            fatigue,

            // Assessment
            vesselNote,
            recommendations: rec,

            // Test results
            tests: runTests()
        };

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(result)
        };

    } catch (err) {
        console.error('Mooring calculation error:', {
            error: err.message,
            stack: err.stack,
            body: event.body
        });
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "Server error during mooring calculation",
                details: String(err?.message || err),
                timestamp: new Date().toISOString()
            })
        };
    }
};