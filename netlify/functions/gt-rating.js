/**
 * GT Rating Model Estimator Backend Function
 * Handles gas turbine power calculations with WHRU and gearbox adjustments
 */

exports.handler = async (event, context) => {
    // Enable CORS
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    // Handle OPTIONS request for CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const input = JSON.parse(event.body);

        // GT Models and their equations (y = a*x + b)
        const gtModels = {
            "LM6000PF": { a: -438.9, b: 49064 },
            "LM6000PF+": { a: -414.04, b: 57497 },
            "LM9000": { a: -857.96, b: 80527 },
            "SGT-750": { a: -322.6, b: 45911 },
            "Titan 350": { a: -288.25, b: 40368 },
            "Titan 250": { a: -192.95, b: 24810 },
            "PGT 25+": { a: -283.12, b: 34520 }
        };

        const {
            model = "LM6000PF",
            customG = -438.9,
            customH = 49064,
            ambientTemp = 25,
            whruAdjustment = 0,
            gearboxAdjustment = 0,
            xMin = 0,
            xMax = 43,
            margin10Value = 10,
            fouling5Value = 5
        } = input;

        // Calculate base Y value
        let baseY;
        if (model === "Custom") {
            baseY = customG * ambientTemp + customH;
        } else if (gtModels[model]) {
            const modelData = gtModels[model];
            baseY = modelData.a * ambientTemp + modelData.b;
        } else {
            throw new Error(`Unknown model: ${model}`);
        }

        // Apply WHRU and Gearbox adjustments
        const adjustmentFactor = 1 + (whruAdjustment / 100) + (gearboxAdjustment / 100);
        const adjustedY = baseY * adjustmentFactor;

        // Calculate Max and Min KW (±2.88% and -2.8% respectively)
        const maxKW = adjustedY * 1.0288;
        const minKW = adjustedY * 0.972;

        // Generate curve data
        const curveData = [];
        for (let x = xMin; x <= xMax; x += 0.5) {
            let y;
            if (model === "Custom") {
                y = customG * x + customH;
            } else {
                const modelData = gtModels[model];
                y = modelData.a * x + modelData.b;
            }
            y = y * adjustmentFactor;
            curveData.push({ x, y });
        }

        // Generate margin line data
        const margin10Data = [];
        const fouling5Data = [];
        for (let x = xMin; x <= xMax; x += 0.5) {
            let y;
            if (model === "Custom") {
                y = customG * x + customH;
            } else {
                const modelData = gtModels[model];
                y = modelData.a * x + modelData.b;
            }
            y = y * adjustmentFactor;

            margin10Data.push({ x, y: y * (1 - margin10Value / 100) });
            fouling5Data.push({ x, y: y * (1 - fouling5Value / 100) });
        }

        // Calculate margin percentages for operating points
        const calculateMargin = (pointY) => {
            if (adjustedY === 0) return 0;
            return ((adjustedY - pointY) / adjustedY) * 100;
        };

        const response = {
            success: true,
            results: {
                calculatedKW: adjustedY,
                maxKW,
                minKW,
                baseY,
                adjustmentFactor
            },
            curveData,
            margin10Data,
            fouling5Data,
            calculateMargin
        };

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(response)
        };

    } catch (error) {
        console.error('GT Rating calculation error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                success: false,
                error: error.message || 'Internal server error'
            })
        };
    }
};
