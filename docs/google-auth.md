# Google sign-in

Direct Google OAuth (authorization-code + PKCE S256) in `server/src/googleAuth.ts`. Not Neon Auth; Neon is storage only.

## Env vars
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (Infisical: Build My house, `/auth`). Without them `/auth/google/start` returns 503 and `/api/auth/providers` reports `{google:false}`.
- `APP_BASE_URL` must be the public origin (prod: `https://app.buildmy.house`). The redirect URI and the cookie `Secure` flag derive from it, never from request headers (safe behind Cloudflare). Optional `GOOGLE_REDIRECT_URI` override.

## Redirect URIs (register with Google)
- `https://app.buildmy.house/auth/google/callback`
- Dev: vite runs on port 1420, so register `http://localhost:1420/auth/google/callback` (or run vite on 5173 with `APP_BASE_URL=http://localhost:5173`). Vite proxies `/auth` and `/api` to the server on 3000.

## Flow
`GET /auth/google/start?returnTo=/path` sets signed 10-min `bmh_oauth` cookie (state, nonce, verifier) and redirects to Google. `GET /auth/google/callback` verifies state, exchanges the code, verifies the ID token (RS256 via Google JWKS, iss, aud, exp, nonce, email_verified), resolves the user (google_sub, else link by verified email, else create with sentinel hash `!google-only`), sets `bmh_session` (httpOnly, SameSite=Lax, 7d) and redirects. Failures redirect to `/?signin=error`.

`requireAuth` accepts the bearer header, else the cookie. `POST /api/auth/session` exchanges the cookie for a bearer token (client compatibility). `POST /api/auth/logout` clears the cookie.

## Notes
- Google-only users delete their account with `confirmEmail`; password change/login do not apply.
- Support chat keys on `users.id`, so one account serves editor saves, waitlist and support.
