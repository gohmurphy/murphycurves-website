// netlify/functions/electrical.js
// FLNG Electrical Load Estimator - Backend calculations

exports.handler = async (event, context) => {
    // Enhanced CORS headers for all responses
    const headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
    };

    console.log('FLNG Electrical function invoked:', event.httpMethod);

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
            mtpa,
            pf,
            scenario,
            driver,
            growth,
            reserve,
            nplus1,
            plotMetric,
            mtpaMin,
            mtpaMax,
            unitA,
            unitB,
            unitC,
            unitD,
            unitE
        } = payload;

        // Basic validation
        const numbers = { mtpa, pf, growth, reserve, mtpaMin, mtpaMax, unitA, unitB, unitC, unitD, unitE };
        for (const [k, v] of Object.entries(numbers)) {
            if (typeof v !== "number" || Number.isNaN(v) || !Number.isFinite(v)) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: `Invalid or missing number for '${k}'` })
                };
            }
        }

        // --- PROPRIETARY FORMULAS (server-only) ---
        // Coefficients from your analyses
        const a_norm = 3154.0620640794054;
        const b_norm = 1184.1899206593946;
        const a_off = 5800.7149281235725;
        const b_off = 834.8685495988943;
        const e_norm_per_mtpa = 37465.509151 / 2.4;
        const e_off_per_mtpa = 47578.143714 / 2.4;

        // Core calculation functions
        function baseKW(mtpa, scenario, driver) {
            if (driver === "Aux-Only") {
                return (scenario === "Normal") ? (a_norm + b_norm * mtpa) : (a_off + b_off * mtpa);
            } else {
                return (scenario === "Normal") ? (e_norm_per_mtpa * mtpa) : (e_off_per_mtpa * mtpa);
            }
        }

        function applyMargins(kW, g, r) {
            return kW * (1 + g / 100 + r / 100);
        }

        function recommendSets(requiredKW, unitKWe, nPlusOne = true) {
            const running = Math.max(1, Math.ceil(requiredKW / unitKWe));
            const total = nPlusOne ? (running + 1) : running;
            const loading = requiredKW / (running * unitKWe);
            return { running, total, loading };
        }

        function genRange(min, max, step = 0.1) {
            const out = [];
            let v = min;
            while (v <= max + 1e-9) {
                out.push(parseFloat(v.toFixed(2)));
                v += step;
            }
            return out;
        }

        // Main calculations
        const kW_base = baseKW(mtpa, scenario, driver);
        const kW_req = applyMargins(kW_base, growth, reserve);
        const kVA_req = kW_req / pf;

        // Generator sizing calculations
        const A = recommendSets(kW_req, unitA, nplus1);
        const B = recommendSets(kW_req, unitB, nplus1);
        const C = recommendSets(kW_req, unitC, nplus1);
        const D = recommendSets(kW_req, unitD, nplus1);
        const E = recommendSets(kW_req, unitE, nplus1);

        // Trend data for chart
        const xs = genRange(Math.min(mtpaMin, mtpaMax), Math.max(mtpaMin, mtpaMax), 0.1);
        const toMetric = (kW) => plotMetric === "kVA" ? (kW / pf) : kW;

        const auxNorm = xs.map(x => ({ x, y: toMetric(a_norm + b_norm * x) }));
        const auxOff = xs.map(x => ({ x, y: toMetric(a_off + b_off * x) }));
        const eNorm = xs.map(x => ({ x, y: toMetric(e_norm_per_mtpa * x) }));
        const eOff = xs.map(x => ({ x, y: toMetric(e_off_per_mtpa * x) }));

        const designPoint = { x: mtpa, y: toMetric(kW_base) };

        const result = {
            // Basic results
            kW_base: Math.round(kW_base * 10) / 10,
            kVA_req: Math.round(kVA_req * 10) / 10,
            pfmarg: `${pf.toFixed(3)} | ${growth.toFixed(0)}% | ${reserve.toFixed(0)}%`,

            // Generator options
            generators: {
                A: { unit: unitA, running: A.running, total: A.total, loading: (A.loading * 100).toFixed(1) },
                B: { unit: unitB, running: B.running, total: B.total, loading: (B.loading * 100).toFixed(1) },
                C: { unit: unitC, running: C.running, total: C.total, loading: (C.loading * 100).toFixed(1) },
                D: { unit: unitD, running: D.running, total: D.total, loading: (D.loading * 100).toFixed(1) },
                E: { unit: unitE, running: E.running, total: E.total, loading: (E.loading * 100).toFixed(1) }
            },

            // Chart data
            chartData: {
                auxNorm,
                auxOff,
                eNorm,
                eOff,
                designPoint,
                plotMetric,
                yAxisLabel: plotMetric === "kVA" ? "Estimated Electrical Load (kVA)" : "Estimated Electrical Load (kW)"
            },

            // Coefficients for display
            coefficients: {
                a_norm: Math.round(a_norm * 10) / 10,
                b_norm: Math.round(b_norm * 10) / 10,
                a_off: Math.round(a_off * 10) / 10,
                b_off: Math.round(b_off * 10) / 10,
                e_norm: Math.round(e_norm_per_mtpa),
                e_off: Math.round(e_off_per_mtpa)
            }
        };

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(result)
        };
    } catch (err) {
        console.error('FLNG electrical calculation error:', {
            error: err.message,
            stack: err.stack,
            body: event.body
        });
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: "Server error during electrical calculation",
                details: String(err?.message || err),
                timestamp: new Date().toISOString()
            })
        };
    }
};