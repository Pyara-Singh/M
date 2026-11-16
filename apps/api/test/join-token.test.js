const test = require('node:test');
const assert = require('node:assert/strict');
const { signJoinToken, verifyJoinToken } = require('../../../packages/contracts/join-token');
test('join tokens are signed, room-scoped, and expire', () => {
  const secret = 'a'.repeat(32);
  const token = signJoinToken({ roomId: 'room-one', userId: 'user', displayName: 'User' }, secret, 1000000);
  assert.equal(verifyJoinToken(token, secret, 'room-one', 1000000).userId, 'user');
  assert.equal(verifyJoinToken(token, secret, 'room-two', 1000000), null);
  assert.equal(verifyJoinToken(token, 'b'.repeat(32), 'room-one', 1000000), null);
  assert.equal(verifyJoinToken(token, secret, 'room-one', 1300000), null);
});
