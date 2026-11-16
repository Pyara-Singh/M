const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, newToken, tokenHash } = require('../src/auth');
test('password hashes verify and session tokens are unpredictable values stored as hashes', async () => {
  const hash = await hashPassword('a long password');
  assert.equal(await verifyPassword('a long password', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
  const token = newToken();
  assert.equal(token.length, 43);
  assert.notEqual(tokenHash(token), token);
  assert.notEqual(token, newToken());
});
