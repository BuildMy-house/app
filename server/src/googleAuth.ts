import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { asyncHandler } from './asyncHandler.js';
import { getJwtSecret } from './config.js';
import { getAppBaseUrl } from './email.js';
import { GOOGLE_ONLY_HASH, isUniqueViolation, parseCookies, signToken } from './auth.js';
import type { DbAdapter, UserRow } from './db.js';

// Single outbound-HTTP seam. Exported (and overridable) so tests can mock every
// external Google call — token exchange and JWKS — without real network I/O.
export const googleHttp: { fetch: typeof globalThis.fetch } = { fetch: globalThis.fetch };

const OAUTH_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const ID_TOKEN_ISSUERS: [string, ...string[]] = ['https://accounts.google.com', 'accounts.google.com'];

const OAUTH_COOKIE = 'bmh_oauth';
const SESSION_COOKIE = 'bmh_session';
const OAUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const JWKS_TTL_MS = 60 * 60 * 1000; // ~1 hour

// Config is read at request time (never at import) so tests and operators can
// set env vars after the module loads.
function googleConfig() {
  const base = getAppBaseUrl();
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? `${base}/auth/google/callback`,
    // Behind Cloudflare the Host/X-Forwarded headers are untrusted; derive the
    // cookie Secure flag only from the configured public origin.
    secure: base.startsWith('https://'),
  };
}

function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// Open-redirect guard: only allow same-origin path targets.
function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  if (value.includes('\\')) return '/';
  if (value.includes('://')) return '/';
  return value;
}

function base64UrlSha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

// Constant-time string compare via fixed-length digests (no length leak).
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

function errorRedirect(res: Response): void {
  res.redirect(302, '/?signin=error');
}

interface OAuthState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

function startHandler(_db: DbAdapter) {
  return (req: Request, res: Response): void => {
    const cfg = googleConfig();
    if (!cfg.clientId || !cfg.clientSecret) {
      res.status(503).json({ error: 'google sign-in is not configured' });
      return;
    }

    const returnTo = sanitizeReturnTo(req.query.returnTo);
    const state = randomBytes(32).toString('hex');
    const nonce = randomBytes(32).toString('hex');
    const verifier = randomBytes(32).toString('base64url');

    const cookie = jwt.sign({ state, nonce, verifier, returnTo }, getJwtSecret(), { expiresIn: '10m' });
    res.cookie(OAUTH_COOKIE, cookie, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.secure,
      path: '/',
      maxAge: OAUTH_TTL_MS,
    });

    const params = new URLSearchParams({
      response_type: 'code',
      scope: 'openid email profile',
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      state,
      nonce,
      code_challenge: base64UrlSha256(verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    res.redirect(302, `${OAUTH_AUTH_ENDPOINT}?${params.toString()}`);
  };
}

interface JwksCache {
  keys: Record<string, unknown>[];
  fetchedAt: number;
}
let jwksCache: JwksCache | null = null;

// Test-only: drop the cached JWKS so a fresh (mocked) key set is fetched.
export function _resetGoogleJwksCache(): void {
  jwksCache = null;
}

async function getSigningKey(kid: string | undefined): Promise<KeyObject> {
  if (!kid) throw new Error('id_token missing kid');
  if (!jwksCache || Date.now() - jwksCache.fetchedAt > JWKS_TTL_MS) {
    const resp = await googleHttp.fetch(JWKS_ENDPOINT);
    if (!resp.ok) throw new Error(`jwks fetch failed (${resp.status})`);
    const data = (await resp.json()) as { keys?: unknown };
    const keys = Array.isArray(data.keys) ? (data.keys as Record<string, unknown>[]) : [];
    jwksCache = { keys, fetchedAt: Date.now() };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error('unknown signing key');
  return createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
}

interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

async function exchangeCode(cfg: ReturnType<typeof googleConfig>, code: string, verifier: string): Promise<string> {
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId!,
    client_secret: cfg.clientSecret!,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  const resp = await googleHttp.fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) throw new Error(`token endpoint returned ${resp.status}`);
  const data = (await resp.json()) as { id_token?: unknown };
  if (typeof data.id_token !== 'string' || !data.id_token) throw new Error('token response missing id_token');
  return data.id_token;
}

async function verifyIdToken(
  idToken: string,
  cfg: ReturnType<typeof googleConfig>,
  expectedNonce: string,
): Promise<GoogleIdentity> {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === 'string') throw new Error('malformed id_token');
  const kid = typeof decoded.header.kid === 'string' ? decoded.header.kid : undefined;
  const key = await getSigningKey(kid);
  const payload = jwt.verify(idToken, key, {
    algorithms: ['RS256'],
    audience: cfg.clientId,
    issuer: ID_TOKEN_ISSUERS,
  }) as jwt.JwtPayload;

  if (payload.nonce !== expectedNonce) throw new Error('nonce mismatch');
  if (payload.email_verified !== true) throw new Error('email not verified');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('id_token missing sub');
  if (typeof payload.email !== 'string' || !payload.email) throw new Error('id_token missing email');
  return {
    sub: payload.sub,
    email: payload.email,
    name: typeof payload.name === 'string' ? payload.name : null,
    picture: typeof payload.picture === 'string' ? payload.picture : null,
  };
}

async function resolveUser(db: DbAdapter, id: GoogleIdentity): Promise<string> {
  const email = id.email.trim().toLowerCase();
  try {
    return await db.transaction(async (tx) => {
      // 1. Known Google identity — refresh volatile fields, never overwrite a name.
      const bySub = await tx.get<UserRow>('SELECT * FROM users WHERE google_sub = ?', id.sub);
      if (bySub) {
        await tx.run(
          'UPDATE users SET picture = COALESCE(?, picture), name = COALESCE(name, ?) WHERE id = ?',
          id.picture,
          id.name,
          bySub.id,
        );
        return bySub.id;
      }
      // 2. Existing password account with the same email — link it (one account everywhere).
      const byEmail = await tx.get<UserRow>('SELECT * FROM users WHERE email = ?', email);
      if (byEmail) {
        await tx.run(
          'UPDATE users SET google_sub = ?, picture = COALESCE(?, picture), name = COALESCE(name, ?) WHERE id = ?',
          id.sub,
          id.picture,
          id.name,
          byEmail.id,
        );
        return byEmail.id;
      }
      // 3. Brand-new Google-only user. The sentinel hash is not valid bcrypt, so
      //    password login can never succeed for this row.
      const newId = randomUUID();
      await tx.run(
        `INSERT INTO users (id, email, password_hash, name, picture, google_sub, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        newId,
        email,
        GOOGLE_ONLY_HASH,
        id.name,
        id.picture,
        id.sub,
        new Date().toISOString(),
      );
      return newId;
    });
  } catch (err) {
    // Concurrent callback/registration race on the unique email or google_sub
    // index — re-select the winner rather than failing the sign-in.
    if (isUniqueViolation(err)) {
      const existing =
        (await db.get<UserRow>('SELECT * FROM users WHERE google_sub = ?', id.sub)) ??
        (await db.get<UserRow>('SELECT * FROM users WHERE email = ?', email));
      if (existing) return existing.id;
    }
    throw err;
  }
}

function callbackHandler(db: DbAdapter) {
  return asyncHandler(async (req: Request, res: Response) => {
    const cfg = googleConfig();
    // The one-shot state cookie is consumed regardless of outcome.
    res.clearCookie(OAUTH_COOKIE, { path: '/' });

    const rawCookie = parseCookies(req.headers.cookie)[OAUTH_COOKIE];
    if (!rawCookie) {
      errorRedirect(res);
      return;
    }

    let state: OAuthState;
    try {
      state = jwt.verify(rawCookie, getJwtSecret()) as OAuthState;
    } catch {
      errorRedirect(res);
      return;
    }

    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const returnedState = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (req.query.error || !code || !returnedState || !safeEqual(returnedState, state.state)) {
      errorRedirect(res);
      return;
    }

    try {
      const idToken = await exchangeCode(cfg, code, state.verifier);
      const identity = await verifyIdToken(idToken, cfg, state.nonce);
      const userId = await resolveUser(db, identity);
      res.cookie(SESSION_COOKIE, signToken(userId), {
        httpOnly: true,
        sameSite: 'lax',
        secure: cfg.secure,
        path: '/',
        maxAge: SESSION_TTL_SECONDS * 1000,
      });
      res.redirect(302, sanitizeReturnTo(state.returnTo));
    } catch {
      // Never leak which verification step failed.
      errorRedirect(res);
    }
  });
}

export function googleAuthRouter(db: DbAdapter): Router {
  const router = Router();
  router.get('/auth/google/start', startHandler(db));
  router.get('/auth/google/callback', callbackHandler(db));
  return router;
}

export const googleApiHandlers = {
  providersHandler(_req: Request, res: Response): void {
    res.json({ google: googleConfigured() });
  },

  sessionHandler(db: DbAdapter) {
    return asyncHandler(async (req: Request, res: Response) => {
      const user = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', req.userId!);
      if (!user) {
        res.status(404).json({ error: 'user not found' });
        return;
      }
      res.json({
        token: signToken(user.id),
        user: { id: user.id, email: user.email, name: user.name ?? null, picture: user.picture ?? null },
      });
    });
  },

  logoutHandler(_req: Request, res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  },
};
