const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

test('meeting creation validates input and persists a generated code', async () => {
  let saved;
  const pool = { query: async (sql, values) => {
    if (sql.startsWith('SELECT user_id')) return { rows: [{ user_id: 'owner' }] };
    saved = values; return { rows: [{ id: values[0], join_code: values[1], title: values[2] }] };
  } };
  const server = createApp(pool).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/meetings`;
  try {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${'a'.repeat(43)}` };
    const anonymous = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anonymous.status, 401);
    const invalid = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ title: ' ' }) });
    assert.equal(invalid.status, 400);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ title: ' Design review ' }) });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.title, 'Design review');
    assert.match(body.join_code, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(saved[0], body.id);
    assert.equal(saved[3], 'owner');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('authenticated users can exchange a meeting code for a scoped token', async () => {
  const oldSecret = process.env.JOIN_TOKEN_SECRET;
  process.env.JOIN_TOKEN_SECRET = 'x'.repeat(32);
  const pool = { query: async (sql) => {
    if (sql.startsWith('SELECT user_id')) return { rows: [{ user_id: 'guest' }] };
    if (sql.startsWith('SELECT m.join_code')) return { rows: [{ join_code: 'abcdefghijklmnop', owner_id: 'host', display_name: 'Guest' }] };
    throw new Error('Unexpected query');
  } };
  const server = createApp(pool).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/meeting-joins`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${'a'.repeat(43)}` }, body: JSON.stringify({ code: 'abcdefghijklmnop' }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    const { verifyJoinToken } = require('../../../packages/contracts/join-token');
    assert.equal(verifyJoinToken(body.token, process.env.JOIN_TOKEN_SECRET, body.roomId).role, 'participant');
  } finally {
    if (oldSecret === undefined) delete process.env.JOIN_TOKEN_SECRET; else process.env.JOIN_TOKEN_SECRET = oldSecret;
    await new Promise(resolve => server.close(resolve));
  }
});
