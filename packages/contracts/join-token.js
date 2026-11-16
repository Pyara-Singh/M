const { createHmac, timingSafeEqual } = require('node:crypto');

function signJoinToken(claims, secret, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('JOIN_TOKEN_SECRET must contain at least 32 characters');
  const payload = Buffer.from(JSON.stringify({ ...claims, aud: 'lesgomeet-sfu', exp: Math.floor(now / 1000) + 300 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function verifyJoinToken(token, secret, roomId, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048 || typeof secret !== 'string' || secret.length < 32) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const actual = Buffer.from(parts[1], 'base64url');
  const expected = createHmac('sha256', secret).update(parts[0]).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (claims.aud !== 'lesgomeet-sfu' || claims.roomId !== roomId || !Number.isInteger(claims.exp) || claims.exp <= Math.floor(now / 1000) || typeof claims.userId !== 'string' || typeof claims.displayName !== 'string' || !claims.displayName.trim() || claims.displayName.length > 32) return null;
    return claims;
  } catch { return null; }
}
module.exports = { signJoinToken, verifyJoinToken };
