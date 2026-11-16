const { randomBytes, scrypt: scryptCallback, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(scryptCallback);

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  const [salt, hex] = encoded.split(':');
  if (!salt || !/^[a-f0-9]{128}$/.test(hex || '')) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}
function newToken() { return randomBytes(32).toString('base64url'); }
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
module.exports = { hashPassword, verifyPassword, newToken, tokenHash };
