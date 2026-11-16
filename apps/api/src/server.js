const { Pool } = require('pg');
const { createApp } = require('./app');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const port = Number(process.env.PORT || 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const server = createApp(pool).listen(port, () => console.log(`API listening on ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => pool.end().then(() => process.exit(0))));
