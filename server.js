require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('Missing JWT_SECRET in environment. Set it before starting the server.');
  process.exit(1);
}

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function adminMiddleware(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return res.status(500).json({ error: 'ADMIN_KEY is not set on the server.' });
  const provided = req.headers['x-admin-key'];
  if (provided !== adminKey) return res.status(401).json({ error: 'Invalid admin key.' });
  next();
}

// ---------------------------------------------------------------------
// Custom username/password auth
// ---------------------------------------------------------------------
app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (username.length < 3 || username.length > 32) {
    return res.status(400).json({ error: 'Username must be 3–32 characters.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const existing = await db.getUserByUsername(username);
  if (existing) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await db.createUser({ username, passwordHash });

  const token = issueToken(user);
  res.json({ token, username: user.username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = await db.getUserByUsername(username);
  if (!user || !user.passwordHash) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  const token = issueToken(user);
  res.json({ token, username: user.username });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  res.json({ username: req.user.username });
});

// ---------------------------------------------------------------------
// Instagram login
// Requires a Meta developer app with the Instagram product configured,
// and these env vars: INSTAGRAM_CLIENT_ID, INSTAGRAM_CLIENT_SECRET,
// INSTAGRAM_REDIRECT_URI (must exactly match the URI registered in the
// Meta app), and FRONTEND_URL (where we send the user back to afterward).
// Meta's Instagram login flow has changed more than once — check the
// current docs at developers.facebook.com/docs/instagram-platform
// before relying on the exact endpoints below.
// ---------------------------------------------------------------------
app.get('/api/instagram/auth', (req, res) => {
  const clientId = process.env.INSTAGRAM_CLIENT_ID;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return res.status(500).send('Instagram login is not configured on this server yet.');
  }
  const authUrl = 'https://www.instagram.com/oauth/authorize'
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&response_type=code`
    + `&scope=${encodeURIComponent('instagram_business_basic')}`;
  res.redirect(authUrl);
});

app.get('/api/instagram/callback', async (req, res) => {
  const { code } = req.query;
  const clientId = process.env.INSTAGRAM_CLIENT_ID;
  const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
  const frontendUrl = process.env.FRONTEND_URL || '/';

  if (!code) return res.status(400).send('Missing authorization code.');

  try {
    const tokenRes = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, user_id } = tokenRes.data;

    const profileRes = await axios.get('https://graph.instagram.com/me', {
      params: { fields: 'id,username', access_token }
    });
    const igId = String(profileRes.data.id || user_id);
    const igUsername = profileRes.data.username || `ig_${igId}`;

    let user = await db.getUserByInstagramId(igId);
    if (!user) {
      user = await db.createUser({ username: igUsername, instagramId: igId });
    }

    const token = issueToken(user);
    res.redirect(`${frontendUrl}?token=${encodeURIComponent(token)}&username=${encodeURIComponent(user.username)}`);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).send('Instagram login failed. Check server logs.');
  }
});

// ---------------------------------------------------------------------
// Admin: read/manage what's in long-term storage. Used by admin.html.
// Protected by a shared ADMIN_KEY (set it in Render's env vars) sent as
// the x-admin-key header — this is a simple shared secret, not a full
// auth system, so treat that key like a password and don't share it.
// ---------------------------------------------------------------------
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  const users = await db.listUsers();
  res.json({
    storage: db.usingPostgres ? 'postgres' : 'json-file (local dev fallback — not long-term)',
    users: users.map(u => ({
      id: u.id,
      username: u.username,
      loginMethod: u.instagramId ? 'instagram' : 'password',
      createdAt: u.createdAt
    }))
  });
});

app.delete('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  await db.deleteUser(req.params.id);
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.send(`Confession Booth auth server is running. Storage: ${db.usingPostgres ? 'Postgres (long-term)' : 'JSON file (local dev only)'}.`);
});

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Auth server listening on port ${PORT} — storage: ${db.usingPostgres ? 'Postgres' : 'JSON file (local dev fallback)'}`);
  });
}).catch(err => {
  console.error('Failed to initialize storage:', err);
  process.exit(1);
});
