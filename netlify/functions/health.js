// Simple health check endpoint for Murphy's Curves FLNG Suite
exports.handler = async (event, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: "healthy",
        message: "Murphy's Curves FLNG Engineering Suite API is running",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
        environment: "production",
        functions: {
          calc: "available",
          mooring: "available",
          health: "available"
        }
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        status: "error",
        message: "Health check failed",
        error: error.message
      })
    };
  }
};