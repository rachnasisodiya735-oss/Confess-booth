# Confession Booth — auth server

A small Express server that handles:
- **Custom login**: `POST /api/signup` and `POST /api/login`, passwords hashed with bcrypt (never stored in plain text).
- **Instagram login**: `GET /api/instagram/auth` → `GET /api/instagram/callback`, scaffolded but needs your own Meta app credentials (see below).
- **Long-term storage**: user records live in a Render Postgres database, not on the server's local disk — so they survive redeploys and restarts.
- **Admin viewer**: `admin.html` (a separate file) reads and manages what's stored, opened on its own.

## Storage: Postgres on Render

1. In the Render dashboard: **New → PostgreSQL**. Free tier is fine to start.
2. Once it's created, open it and copy the **Internal Connection String** (if your web service is also on Render — faster, no external hop) or the **External Connection String** (if connecting from anywhere else, e.g. running the server on your own machine against the Render DB).
3. Set that as `DATABASE_URL` in your web service's environment variables.
4. That's it — the server creates its `users` table automatically on startup if it doesn't exist yet.

If `DATABASE_URL` isn't set, the server falls back to a `users.json` file so you can still run it locally without Postgres. That fallback is for local testing only — Render's free web service disk is wiped on every redeploy, so it is **not** long-term storage.

## Run locally

```
cd server
npm install
cp .env.example .env
# fill in JWT_SECRET and (optionally) DATABASE_URL
npm start
```

Server runs on `http://localhost:3000`.

## Deploy to Render

1. Push this `server/` folder to a GitHub repo.
2. **New → Web Service**, connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add environment variables (see `.env.example`):
   - `JWT_SECRET` — any long random string.
   - `DATABASE_URL` — from the Postgres database you created above.
   - `ADMIN_KEY` — a secret only you know, for the records viewer.
   - `FRONTEND_ORIGIN` — the URL your HTML file is opened/served from, or `*` if you're just opening it locally.
   - `FRONTEND_URL`, `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET`, `INSTAGRAM_REDIRECT_URI` — only needed for Instagram login (next section).
5. Deploy. Render gives you a URL like `https://confession-booth-auth.onrender.com` — paste that into the game's "Backend URL" field.

## Setting up Instagram login

1. Go to [developers.facebook.com](https://developers.facebook.com), create an app, and add the **Instagram** product to it.
2. Add an OAuth redirect URI: `https://<your-render-url>/api/instagram/callback` — must match `INSTAGRAM_REDIRECT_URI` exactly.
3. Copy the app's Client ID and Client Secret into `INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET` on Render.
4. Set `FRONTEND_URL` to wherever the game page itself is hosted (it needs a real URL to redirect back to — a locally opened file won't work here).
5. Meta has changed this flow more than once (scopes, endpoints, review requirements). Check `developers.facebook.com/docs/instagram-platform` before going live — Meta may require app review before real users outside your own test accounts can log in.

## Records viewer (`admin.html`)

A separate page for looking at what's actually stored in the database — usernames, login method, and signup date (never passwords or password hashes).

Open `admin.html` directly, same as the game file. It asks for:
- **Backend URL** — same Render URL as the game.
- **Admin key** — whatever you set `ADMIN_KEY` to on Render.

From there it lists every account and lets you delete one if needed. Keep the admin key private — anyone who has it can view and delete accounts.

## API summary

| Endpoint | Method | Auth | Body | Returns |
|---|---|---|---|---|
| `/api/signup` | POST | — | `{ username, password }` | `{ token, username }` |
| `/api/login` | POST | — | `{ username, password }` | `{ token, username }` |
| `/api/me` | GET | Bearer token | — | `{ username }` |
| `/api/instagram/auth` | GET | — | — | redirects to Instagram |
| `/api/instagram/callback` | GET | — | — | redirects to `FRONTEND_URL?token=...&username=...` |
| `/api/admin/users` | GET | `x-admin-key` header | — | `{ storage, users: [...] }` |
| `/api/admin/users/:id` | DELETE | `x-admin-key` header | — | `{ ok: true }` |
