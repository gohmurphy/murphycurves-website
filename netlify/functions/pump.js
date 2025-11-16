// netlify/functions/pump.js
// Server-side centrifugal pump sizing calculations
// All proprietary pump formulas protected server-side for IP protection

exports.handler = async (event, context) => {
    // Enhanced CORS headers for all responses
    const headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
    };

    console.log('Pump sizing function invoked:', event.httpMethod);

    // Handle preflight OPTIONS request
    if (event.httpMethod === "OPTIONS") {
        return {
            statusCode: 200,
            headers,
            body: ""
        };
    }

    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: "Method not allowed" })
        };
    }

    try {
        const payload = JSON.parse(event.body || "{}");
        const {
            n: N,              // Speed (rpm)
            q: Q,              // Flow Rate (m³/hr)
            tdhm: TDHm,        // Total Dynamic Head (meters)
            npsha: NPSHA,      // NPSHA (meters)
            suctype: SucType,  // Suction Type (1=single, 2=double)
            sg: SG,            // Specific Gravity
            num_impellers: NumImpellers, // Number of Impellers
            viscosity: Viscosity // Viscosity (centistoke)
        } = payload;

        // Basic validation
        const numbers = { N, Q, TDHm, NPSHA, SucType, SG, NumImpellers, Viscosity };
        for (const [k, v] of Object.entries(numbers)) {
            if (typeof v !== "number" || Number.isNaN(v) || !Number.isFinite(v)) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: `Invalid or missing number for '${k}'` })
                };
            }
        }

        // --- PROPRIETARY PUMP SIZING FORMULAS (server-only) ---
        const HeadStage = TDHm / NumImpellers;
        const AngVel = (Math.PI / 30) * N;
        const Ns = N * Math.pow(Q / 3600, 0.5) / Math.pow(HeadStage, 0.75);
        const Uns = Ns / 52.919;
        const Nss = N * Math.pow((Q / SucType) / 3600, 0.5) / Math.pow(NPSHA, 0.75);
        const UNss = Nss / 52.919;

        let Phi;
        if (Uns > 1) {
            Phi = 0.4 / Math.pow(Uns, 0.5);
        } else {
            Phi = 0.4 / Math.pow(Uns, 0.25);
        }

        const r2 = (1 / AngVel) * Math.sqrt(9.81 * HeadStage / Phi);
        const ImpDia = r2 * 2 * 1000;
        const U2 = AngVel * (ImpDia / 2 / 1000);
        const Qus = Q * 4.402867;
        const Nus = Ns * 51.66;

        let Eff = 0.94 - (0.08955 * Math.pow(Qus / N, -0.2133)) - (0.29 * Math.pow(Math.log10(2286 / Nus), 2));
        Eff -= 0.005 * (NumImpellers - 1);

        const kW = (Q * TDHm * SG) / (367.63 * Eff);
        const Re = Math.pow((Q / SucType) / 3600, 0.5) * Math.pow(9.81 * HeadStage, 0.25) / (Viscosity * 1e-6);

        // Viscous correction calculations
        const { CQ, CH, CE } = calculateViscousCorrection(Re);

        // Determine Ns status
        let Nstatus, statusText;
        if (Ns > 175) { Nstatus = "Ns7"; statusText = "Very High Ns"; }
        else if (Ns > 100) { Nstatus = "Ns6"; statusText = "High Ns"; }
        else if (Ns > 80) { Nstatus = "Ns5"; statusText = "Medium-High Ns"; }
        else if (Ns > 60) { Nstatus = "Ns4"; statusText = "Medium Ns"; }
        else if (Ns > 40) { Nstatus = "Ns3"; statusText = "Medium-Low Ns"; }
        else if (Ns > 20) { Nstatus = "Ns2"; statusText = "Low Ns"; }
        else { Nstatus = "Ns1"; statusText = "Very Low Ns"; }

        // Generate warnings
        const warnings = generateWarnings(Ns, U2, NPSHA, Nss);

        // Performance curve data
        const performanceData = generatePerformanceData(Q, TDHm, Eff, NPSHA, Nstatus, SG);

        // New pump performance for low Ns
        let newPumpPerformance = null;
        if ((Q > 20 && Q < 61 && Ns < 20) || (Ns < 18 && Q <= 20)) {
            newPumpPerformance = calculateNewPumpPerformance(Ns, Q, TDHm, ImpDia, NPSHA, N, SG, Eff);
        }

        const result = {
            efficiency: +(Eff * 100).toFixed(2),
            uns: +Uns.toFixed(4),
            ns: +Ns.toFixed(2),
            unss: +UNss.toFixed(4),
            nss: +Nss.toFixed(2),
            phi: +Phi.toFixed(4),
            angvel: +AngVel.toFixed(2),
            tipspeed: +U2.toFixed(2),
            impdia: +ImpDia.toFixed(2),
            headstage: +HeadStage.toFixed(1),
            hydpower: +kW.toFixed(2),
            reynolds: +Re.toFixed(2),
            cq: +CQ.toFixed(2),
            ch: +CH.toFixed(2),
            ce: +CE.toFixed(2),
            nstatus: Nstatus,
            statusText: statusText,
            warnings: warnings,
            performanceData: performanceData,
            newPumpPerformance: newPumpPerformance
        };

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(result)
        };

    } catch (err) {
        console.error('Pump calculation error:', {
            error: err.message,
            stack: err.stack,
            body: event.body
        });
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: "Server error during pump calculation",
                details: String(err?.message || err),
                timestamp: new Date().toISOString()
            })
        };
    }
};

// --- PROPRIETARY HELPER FUNCTIONS (server-only) ---

function calculateViscousCorrection(Re) {
    const cq_a = 0.151;
    const cq_b = 398.3;
    const cq_c = 1.012;
    const cq_d = 0.999;
    const ch_a = 1.004;
    const ch_b = 1.391;
    const ch_c = 0.394;
    const ch_d = 0.233;
    const ce_a = 1.016;
    const ce_b = 2.848;
    const ce_c = 0.369;
    const ce_d = 0.204;

    const Ch = ch_a - ch_b * Math.exp(-ch_c * Math.pow(Re, ch_d));
    const Ce = ce_a - ce_b * Math.exp(-ce_c * Math.pow(Re, ce_d));
    const Cq = 1.0; // Always remains 1 per user requirement

    return { CQ: Cq, CH: Ch, CE: Ce };
}

function generateWarnings(Ns, U2, NPSHA, Nss) {
    const warnings = [];
    if (Ns < 20) { warnings.push({ text: "Ns is too low!", critical: true }); }
    else if (Ns > 250) { warnings.push({ text: "Ns is too high - cannot build this pump", critical: true }); }
    if (U2 > 55) { warnings.push({ text: "Tip speed too high for dirty service", critical: true }); }
    if (NPSHA > 10) { warnings.push({ text: "You have more NPSHA than needed", critical: false }); }
    if (Nss > 213) { warnings.push({ text: "Suction specific speed (Nss) is too high", critical: true }); }
    else if (Nss < 50) { warnings.push({ text: "Suction specific speed (Nss) is very low", critical: false }); }
    return warnings;
}

function generatePerformanceData(Q, TDHm, Eff, NPSHA, Nstatus, SG) {
    // Curve coefficients (proprietary data)
    const curveCoefficients = {
        head: {
            Ns1: { a: 120.8, b: -0.21384782, c: 0.010905096, d: -0.00021595602, e: 1.3648307e-06, f: -2.8993229e-09 },
            Ns2: { a: 142, b: -0.223337, c: -0.0055263614, d: 0.00018385812, e: -2.3572357e-06, f: 8.7462759e-09 },
            Ns3: { a: 160, b: -0.40244256, c: -0.0057075647, d: 0.00014007848, e: -1.5704207e-06, f: 5.4283494e-09 },
            Ns4: { a: 175, b: -0.56557259, c: -0.0068800616, d: 0.00019610839, e: -2.3296197e-06, f: 8.7211455e-09 },
            Ns5: { a: 185, b: -1.4234848, c: 0.015568182, d: 0.00015742424, e: -4.6181818e-06, f: 2.0606061e-08 },
            Ns6: { a: 225, b: -1.2501499, c: -0.068654179, d: 0.0024996503, e: -2.7729337e-05, f: 9.5984016e-08 },
            Ns7: { a: 380, b: -4.3295704, c: -0.11964691, d: 0.0044487801, e: -4.5967011e-05, f: 1.4973471e-07 }
        },
        efficiency: {
            Ns1: { a: 0, b: 2.4445788, c: -0.014159341, d: -0.00012353846, e: 1.869011e-06, f: -6.6227106e-09 },
            Ns2: { a: 0, b: 2.2298868, c: -0.010668343, d: -9.6486402e-05, e: 1.1941303e-06, f: -3.9231879e-09 },
            Ns3: { a: 0, b: 2.5249317, c: -0.032144311, d: 0.00039017405, e: -3.1181796e-06, f: 9.0593851e-09 },
            Ns4: { a: 0, b: 2.2583217, c: -0.023349029, d: 0.00024363947, e: -1.8396892e-06, f: 4.7987568e-09 },
            Ns5: { a: 0, b: 2.4710846, c: -0.032865937, d: 0.00046168625, e: -4.0147e-06, f: 1.2133467e-08 },
            Ns6: { a: 0, b: 1.7089419, c: -0.0089007132, d: 6.4419969e-05, e: -4.1622822e-07, f: -4.6842047e-10 },
            Ns7: { a: 0, b: 1.4879138, c: -0.0017261461, d: -0.00010420124, e: 1.4956333e-06, f: -7.6891997e-09 }
        },
        npsh: {
            Ns1: { a: 48, b: 0.23681818, c: -0.014001515, d: 0.00039790909, e: -3.9684848e-06, f: 1.6727273e-08 },
            Ns2: { a: 72, b: 0.061821512, c: -0.015774015, d: 0.00034247242, e: -2.9996848e-06, f: 1.3705406e-08 },
            Ns3: { a: 98, b: -0.32168731, c: -0.034086057, d: 0.00083099627, e: -7.1443383e-06, f: 2.5846687e-08 },
            Ns4: { a: 120, b: -0.83951382, c: -0.011862737, d: 0.00035402331, e: -3.2840759e-06, f: 1.5696304e-08 },
            Ns5: { a: 186, b: -0.72372627, c: -0.050911699, d: 0.0011401943, e: -1.1171744e-05, f: 4.7246975e-08 },
            Ns6: { a: 403, b: -3.4442574, c: -0.063122994, d: 0.0019938438, e: -2.4935358e-05, f: 1.1723477e-07 },
            Ns7: { a: 1000, b: -6.9291126, c: -0.19079618, d: 0.0035209596, e: -3.6734776e-05, f: 1.8533911e-07 }
        }
    };

    const headCoeffs = curveCoefficients.head[Nstatus];
    const efficiencyCoeffs = curveCoefficients.efficiency[Nstatus];
    const npshCoeffs = curveCoefficients.npsh[Nstatus];

    const flowPercentages = [0, 25, 50, 75, 100, 130];
    const flowPoints = flowPercentages.map(p => p * Q / 100);

    const headPoints = flowPoints.map((flow, index) => {
        const qPercent = flowPercentages[index];
        return lagrangianInterpolation(qPercent, headCoeffs) * (TDHm / 100);
    });

    const efficiencyPoints = flowPoints.map((flow, index) => {
        const qPercent = flowPercentages[index];
        const eff = lagrangianInterpolation(qPercent, efficiencyCoeffs) * Eff;
        return Math.max(0, Math.min(100, eff));
    });

    const npshPoints = flowPoints.map((flow, index) => {
        const qPercent = flowPercentages[index];
        const npsh = lagrangianInterpolation(qPercent, npshCoeffs) * (NPSHA / 100);
        return Math.max(0, npsh);
    });

    const powerPoints = flowPoints.map((flow, i) => {
        if (flow === 0) {
            const powerAt20 = (flowPoints[1] * headPoints[1] * SG) / (367.63 * (efficiencyPoints[1] / 100 || 0.01));
            return 0.9 * powerAt20;
        } else {
            return (flow * headPoints[i] * SG) / (367.63 * (efficiencyPoints[i] / 100 || 0.01));
        }
    });

    return { flowPoints, headPoints, efficiencyPoints, npshPoints, powerPoints, flowPercentages };
}

function calculateNewPumpPerformance(Ns, Q, TDHm, ImpDia, NPSHA, N, SG, originalEff) {
    let newEfficiencyPercent;

    if (Q > 20 && Q < 61 && Ns < 20) {
        newEfficiencyPercent = (originalEff * 100) - 9.89;
    } else if (Ns < 18 && Q <= 20) {
        const newEfficiency = -8.84553e-3 + (7.9485e-2 * Ns) - (4.0913e-3 * Math.pow(Ns, 2)) + (1.08499e-4 * Math.pow(Ns, 3)) - (1.40755e-6 * Math.pow(Ns, 4)) + (5.4971e-9 * Math.pow(Ns, 5)) + (4.07879e-11 * Math.pow(Ns, 6)) - (2.66217e-13 * Math.pow(Ns, 7));
        newEfficiencyPercent = newEfficiency * 100;
    } else {
        newEfficiencyPercent = (originalEff * 100) - 9.89;
    }

    newEfficiencyPercent = Math.max(0, Math.min(100, newEfficiencyPercent));
    const newHydPower = (Q * TDHm * SG) / (367.63 * (newEfficiencyPercent / 100));

    return {
        flow: +Q.toFixed(2),
        head: +TDHm.toFixed(2),
        ns: +Ns.toFixed(2),
        impdia: +ImpDia.toFixed(2),
        npsh: +NPSHA.toFixed(2),
        speed: +N.toFixed(0),
        efficiency: +newEfficiencyPercent.toFixed(2),
        hydpower: +newHydPower.toFixed(2)
    };
}

function lagrangianInterpolation(x, coefficients) {
    return coefficients.a + coefficients.b * x + coefficients.c * Math.pow(x, 2) +
        coefficients.d * Math.pow(x, 3) + coefficients.e * Math.pow(x, 4) +
        coefficients.f * Math.pow(x, 5);
}