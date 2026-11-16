const express = require('express');
const { randomUUID, randomBytes } = require('node:crypto');
const { hashPassword, verifyPassword, newToken, tokenHash } = require('./auth');
const { signJoinToken } = require('../../../packages/contracts/join-token');

function createApp(pool) {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.get('/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ready: true }); }
    catch { res.status(503).json({ ready: false }); }
  });
  app.post('/v1/auth/register', async (req, res, next) => {
    const { email, password, displayName } = req.body || {};
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || typeof password !== 'string' || password.length < 12 || password.length > 128 || typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 80) return res.status(400).json({ error: 'Invalid registration details' });
    try {
      const result = await pool.query('INSERT INTO users (id, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, email, display_name', [randomUUID(), email.trim().toLowerCase(), displayName.trim(), await hashPassword(password)]);
      res.status(201).json(result.rows[0]);
    } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'Account already exists' }); next(error); }
  });
  app.post('/v1/auth/login', async (req, res, next) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || password.length > 128) return res.status(400).json({ error: 'Invalid credentials' });
    try {
      const result = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email.trim().toLowerCase()]);
      if (!result.rows[0] || !await verifyPassword(password, result.rows[0].password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
      const token = newToken();
      await pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,now() + interval '12 hours')", [tokenHash(token), result.rows[0].id]);
      res.json({ token, expiresIn: 43200 });
    } catch (error) { next(error); }
  });
  async function authenticate(req, res, next) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '');
    if (!match) return res.status(401).json({ error: 'Authentication required' });
    try {
      const result = await pool.query('SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()', [tokenHash(match[1])]);
      if (!result.rows[0]) return res.status(401).json({ error: 'Invalid session' });
      req.userId = result.rows[0].user_id; req.sessionHash = tokenHash(match[1]); next();
    } catch (error) { next(error); }
  }
  app.post('/v1/auth/logout', authenticate, async (req, res, next) => {
    try { await pool.query('DELETE FROM sessions WHERE token_hash = $1', [req.sessionHash]); res.sendStatus(204); } catch (error) { next(error); }
  });
  app.post('/v1/meetings', authenticate, async (req, res, next) => {
    const title = req.body?.title;
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 160) return res.status(400).json({ error: 'Invalid title' });
    try {
      const id = randomUUID();
      const joinCode = randomBytes(12).toString('base64url');
      const result = await pool.query('INSERT INTO meetings (id, join_code, title, owner_id) VALUES ($1, $2, $3, $4) RETURNING id, join_code, title, created_at', [id, joinCode, title.trim(), req.userId]);
      res.status(201).json(result.rows[0]);
    } catch (error) { next(error); }
  });
  app.post('/v1/meetings/:id/join-tokens', authenticate, async (req, res, next) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid meeting ID' });
    if (!process.env.JOIN_TOKEN_SECRET || process.env.JOIN_TOKEN_SECRET.length < 32) return res.status(503).json({ error: 'Join tokens are not configured' });
    try {
      const result = await pool.query('SELECT m.join_code, u.display_name FROM meetings m JOIN users u ON u.id = m.owner_id WHERE m.id = $1 AND m.owner_id = $2', [req.params.id, req.userId]);
      if (!result.rows[0]) return res.status(404).json({ error: 'Meeting not found' });
      const { join_code, display_name } = result.rows[0];
      const token = signJoinToken({ roomId: join_code, userId: req.userId, displayName: display_name.slice(0, 32), role: 'host' }, process.env.JOIN_TOKEN_SECRET);
      res.json({ token, roomId: join_code, expiresIn: 300 });
    } catch (error) { next(error); }
  });
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
module.exports = { createApp };
