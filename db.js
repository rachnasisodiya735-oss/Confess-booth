// ---------------------------------------------------------------------
// Storage layer.
//
// If DATABASE_URL is set (Render's Postgres connection string), every
// user record is read from and written to that database — this is the
// long-term store: it survives redeploys and restarts, unlike a JSON
// file on the server's local disk.
//
// If DATABASE_URL is NOT set, this falls back to a users.json file so
// you can run the server locally without spinning up Postgres. That
// fallback is for local dev only — don't rely on it in production.
// ---------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const usingPostgres = !!process.env.DATABASE_URL;
let pool = null;
let ready; // promise that resolves once the table exists (Postgres mode)

if (usingPostgres) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Render's managed Postgres requires SSL; its certs aren't in most
    // default trust stores, so this relaxes verification. Fine for a
    // hobby project talking to your own Render database.
    ssl: { rejectUnauthorized: false }
  });

  ready = pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      instagram_id TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
} else {
  console.warn('DATABASE_URL not set — falling back to users.json for local dev only. Set DATABASE_URL (Render Postgres) for long-term storage.');
  ready = Promise.resolve();
}

const JSON_PATH = path.join(__dirname, 'users.json');

function readJsonUsers() {
  if (!fs.existsSync(JSON_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')); }
  catch (e) { return []; }
}
let jsonWriteQueue = Promise.resolve();
function writeJsonUsers(users) {
  jsonWriteQueue = jsonWriteQueue.then(() => {
    fs.writeFileSync(JSON_PATH, JSON.stringify(users, null, 2));
  });
  return jsonWriteQueue;
}

function newId() {
  return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function init() {
  await ready;
}

async function getUserByUsername(username) {
  if (usingPostgres) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE lower(username) = lower($1)', [username]
    );
    return rows[0] ? toCamel(rows[0]) : null;
  }
  const users = readJsonUsers();
  return users.find(u => u.username.toLowerCase() === username.toLowerCase()) || null;
}

async function getUserByInstagramId(instagramId) {
  if (usingPostgres) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE instagram_id = $1', [instagramId]
    );
    return rows[0] ? toCamel(rows[0]) : null;
  }
  const users = readJsonUsers();
  return users.find(u => u.instagramId === instagramId) || null;
}

async function createUser({ username, passwordHash, instagramId }) {
  const id = newId();
  const createdAt = new Date().toISOString();
  if (usingPostgres) {
    const { rows } = await pool.query(
      `INSERT INTO users (id, username, password_hash, instagram_id, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, username, passwordHash || null, instagramId || null, createdAt]
    );
    return toCamel(rows[0]);
  }
  const users = readJsonUsers();
  const user = { id, username, passwordHash: passwordHash || null, instagramId: instagramId || null, createdAt };
  users.push(user);
  await writeJsonUsers(users);
  return user;
}

async function listUsers() {
  if (usingPostgres) {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
    return rows.map(toCamel);
  }
  return readJsonUsers().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function deleteUser(id) {
  if (usingPostgres) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    return;
  }
  const users = readJsonUsers().filter(u => u.id !== id);
  await writeJsonUsers(users);
}

function toCamel(row) {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    instagramId: row.instagram_id,
    createdAt: row.created_at
  };
}

module.exports = {
  usingPostgres,
  init,
  getUserByUsername,
  getUserByInstagramId,
  createUser,
  listUsers,
  deleteUser
};
