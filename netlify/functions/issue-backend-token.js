// netlify/functions/issue-backend-token.js
const jwt = require('jsonwebtoken');

const TEN_MINUTES_SECONDS = 10 * 60;

function getOrigin(event) {
  return event.headers.origin || event.headers.Origin || '';
}

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

// TEMP session check for testing: looks for cookie "murphy_session" or header "x-murphy-user-id"
function validateMurphySession(event) {
  const cookie = event.headers.cookie || '';
  const hasSessionCookie = /(^|;\s*)murphy_session=/.test(cookie);
  const userIdHeader = event.headers['x-murphy-user-id'] || event.headers['X-Murphy-User-Id'];
  const userId = userIdHeader || (hasSessionCookie ? 'session-user' : null);
  if (!userId) return null;

  const emailHeader = event.headers['x-murphy-email'] || event.headers['X-Murphy-Email'] || '';
  return {
    userId: String(userId),
    email: String(emailHeader || ''),
    roles: ['member'],
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
      return json(405, { error: 'Method Not Allowed' });
    }

    const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
    const origin = getOrigin(event);
    if (allowedOrigin && origin && origin !== allowedOrigin) {
      return json(403, { error: 'Forbidden origin' });
    }

    const session = validateMurphySession(event);
    if (!session) {
      return json(401, { error: 'Not authenticated' });
    }

    const secret = process.env.JWT_SIGNING_SECRET;
    if (!secret) {
      return json(500, { error: 'JWT_SIGNING_SECRET not set' });
    }

    const now = Math.floor(Date.now() / 1000);
    const exp = now + TEN_MINUTES_SECONDS;

    const payload = {
      sub: session.userId,
      email: session.email || undefined,
      roles: session.roles || ['member'],
      iss: 'https://murphycurves.com',
      aud: 'murphy-ai',
      iat: now,
      exp,
    };

    const token = jwt.sign(payload, secret, { algorithm: 'HS256' });

    return json(200, { token, expiresInSeconds: TEN_MINUTES_SECONDS }, {
      'Access-Control-Allow-Origin': allowedOrigin || origin || '*',
      'Access-Control-Allow-Credentials': 'true',
    });
  } catch {
    return json(500, { error: 'Token issuance failed' });
  }
};
