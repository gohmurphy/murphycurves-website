// netlify/functions/calc.js
// netlify/functions/calc.js
// Protects your core formulas by executing them on the server (not visible to the browser).

exports.handler = async (event, context) => {
  // Enhanced CORS headers for all responses
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  console.log('FLNG Calc function invoked:', event.httpMethod);

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
      target,           // mmtpa
      availability,     // fraction 0..1
      tankSize,         // m^3
      numTanks,
      lngDensity,       // kg/m^3
      offloadingRate,   // m^3/hr (total)
      pumpsPerTank
    } = payload;

    // Basic validation
    const numbers = { target, availability, tankSize, numTanks, lngDensity, offloadingRate, pumpsPerTank };
    for (const [k, v] of Object.entries(numbers)) {
      if (typeof v !== "number" || Number.isNaN(v) || !Number.isFinite(v)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: `Invalid or missing number for '${k}'` })
        };
      }
    }

    // --- YOUR PROPRIETARY FORMULAS (server-only) ---
    // These mirror what was in your front-end but now stay private.
    const annualDays = 365 * availability;
    const annualProduction = target * 1_000_000; // mmtpa -> tonnes
    const lngVolume = (annualProduction * 1000) / lngDensity; // tonnes->kg->m^3

    const feedGasFlowrate = lngVolume * 620 / (24 * annualDays); // Sm^3/hr
    const feedGasFlowratemmscfd = (feedGasFlowrate * 35.3147 * 24) / 1_000_000; // mmscfd
    const lngProductionRate = lngVolume / annualDays; // m^3/day
    const lngProductionRateKg = lngProductionRate * lngDensity; // kg/day

    const inventoryTurns = lngVolume / tankSize;
    const tankPumpRate = offloadingRate / numTanks;
    const pumpRate = tankPumpRate / pumpsPerTank;
    const pumpRateDay = pumpRate * 24;

    // Offloading time scenarios for carrier sizes
    const carriers = [180000, 225000, 265000];
    const table = carriers.map((size) => {
      const full = size / offloadingRate;
      const fail1 = size / Math.max(1e-9, (offloadingRate - pumpRate));
      const fail2 = size / Math.max(1e-9, (offloadingRate - 2 * pumpRate));
      const stagnant = Math.max(0, tankSize - size);
      const available = Math.min(tankSize, size);
      return {
        size,
        full: +full.toFixed(1),
        fail1: +fail1.toFixed(1),
        fail2: +fail2.toFixed(1),
        stagnant: Math.round(stagnant),
        available: Math.round(available)
      };
    });

    // Chart data based on 180k scenario
    const chartData = table[0] ? [table[0].full, table[0].fail1, table[0].fail2] : [0, 0, 0];

    const result = {
      annualDays: +annualDays.toFixed(1),
      annualProduction: Math.round(annualProduction),
      lngVolume: Math.round(lngVolume),
      inventoryTurns: +inventoryTurns.toFixed(1),
      tankPumpRate: Math.round(tankPumpRate),
      pumpRate: Math.round(pumpRate),
      pumpRateDay: Math.round(pumpRateDay),
      feedGasFlowrate: Math.round(feedGasFlowrate),
      feedGasFlowratemmscfd: Math.round(feedGasFlowratemmscfd),
      lngProductionRate: Math.round(lngProductionRate),
      lngProductionRateKg: Math.round(lngProductionRateKg),
      table,
      chartData
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };
  } catch (err) {
    console.error('FLNG calculation error:', {
      error: err.message,
      stack: err.stack,
      body: event.body
    });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Server error during FLNG calculation",
        details: String(err?.message || err),
        timestamp: new Date().toISOString()
      })
    };
  }
};
