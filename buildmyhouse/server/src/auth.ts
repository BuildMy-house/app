import { randomUUID, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { asyncHandler } from './asyncHandler.js';
import { getJwtSecret } from './config.js';
import { sendEmail, getAppBaseUrl } from './email.js';
import type { DbAdapter, UserRow } from './db.js';
import type { AssetStorage } from './storage.js';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LENGTH = 8;
const TOKEN_TTL = '7d';

// ponytail: in-memory per-email login lockout (per-process, lost on restart).
// Upgrade to a shared/DB-backed limiter only if multi-instance deployment ever happens.
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; windowStart: number }>();

const MAX_REG_PER_IP = 5;
const REG_WINDOW_MS = 15 * 60 * 1000;
const regAttempts = new Map<string, { count: number; windowStart: number }>();

export function _resetRegRateLimit(): void {
  regAttempts.clear();
}

// ponytail: in-memory per-IP limiters for email-sending endpoints (per-process,
// lost on restart). Mirror of the registerHandler pattern with separate counters.
const MAX_EMAIL_PER_IP = 5;
const EMAIL_WINDOW_MS = 15 * 60 * 1000;

function makeIpRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; windowStart: number }>();
  return {
    // Returns true if allowed, false if blocked. Counts every allowed attempt.
    allow(ip: string): boolean {
      const now = Date.now();
      const entry = hits.get(ip);
      if (entry && now - entry.windowStart <= windowMs && entry.count >= max) {
        return false;
      }
      if (!entry || now - entry.windowStart > windowMs) {
        hits.set(ip, { count: 1, windowStart: now });
      } else {
        entry.count += 1;
      }
      if (hits.size > 1000) {
        for (const [key, e] of hits) {
          if (now - e.windowStart > windowMs) hits.delete(key);
        }
      }
      return true;
    },
    clear(): void {
      hits.clear();
    },
  };
}

const pwResetLimiter = makeIpRateLimiter(MAX_EMAIL_PER_IP, EMAIL_WINDOW_MS);
const magicLinkLimiter = makeIpRateLimiter(MAX_EMAIL_PER_IP, EMAIL_WINDOW_MS);

export function _resetEmailRateLimits(): void {
  pwResetLimiter.clear();
  magicLinkLimiter.clear();
}

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1h
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15m

// 256 bits of entropy — not guessable or enumerable.
function generateToken(): string {
  return randomBytes(32).toString('hex');
}

// Constant body for both "/request" endpoints — identical whether or not the
// email exists, so responses carry zero user-existence information.
const REQUEST_ACCEPTED = {
  ok: true,
  message: 'If an account exists for that email, a link has been sent.',
};

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

interface TokenRow {
  id: string;
  user_id?: string;
  email?: string;
  token: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

// Atomically claim a token: flips used_at in the same statement that checks
// expiry and non-reuse, so concurrent requests cannot both consume it.
async function claimToken(db: DbAdapter, table: string, token: string): Promise<TokenRow | undefined> {
  const nowIso = new Date().toISOString();
  const result = await db.run(
    `UPDATE ${table} SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at > ?`,
    nowIso,
    token,
    nowIso,
  );
  if (result.changes === 0) return undefined;
  // `${table}` comes only from hardcoded call sites below, never user input.
  return db.get<TokenRow>(`SELECT * FROM ${table} WHERE token = ?`, token);
}

type Credentials = { email: string; password: string };

export function validateCredentials(email: unknown, password: unknown): Credentials | string {
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return 'email must be a valid email address';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return { email: email.trim().toLowerCase(), password };
}

export function signToken(userId: string): string {
  return jwt.sign({}, getJwtSecret(), { subject: userId, expiresIn: TOKEN_TTL });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string' &&
    ((err as { code: string }).code.startsWith('SQLITE_CONSTRAINT') ||
      (err as { code: string }).code === '23505')
  );
}

export function registerHandler(db: DbAdapter) {
  return asyncHandler(async (req: Request, res: Response) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = regAttempts.get(ip);
    if (entry && now - entry.windowStart <= REG_WINDOW_MS && entry.count >= MAX_REG_PER_IP) {
      res.status(429).json({ error: 'too many registration attempts, try again later' });
      return;
    }
    if (!entry || now - entry.windowStart > REG_WINDOW_MS) {
      regAttempts.set(ip, { count: 1, windowStart: now });
    } else {
      entry.count += 1;
    }
    if (regAttempts.size > 1000) {
      for (const [key, e] of regAttempts) {
        if (now - e.windowStart > REG_WINDOW_MS) regAttempts.delete(key);
      }
    }

    const valid = validateCredentials(req.body?.email, req.body?.password);
    if (typeof valid === 'string') {
      res.status(400).json({ error: valid });
      return;
    }

    const existing = await db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', valid.email);
    if (existing) {
      res.status(409).json({ error: 'email already registered' });
      return;
    }

    const user: UserRow = {
      id: randomUUID(),
      email: valid.email,
      password_hash: bcrypt.hashSync(valid.password, 10),
      name: null,
      created_at: new Date().toISOString(),
    };
    try {
      await db.run(
        `INSERT INTO users (id, email, password_hash, created_at)
         VALUES (?, ?, ?, ?)`,
        user.id,
        user.email,
        user.password_hash,
        user.created_at,
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'email already registered' });
        return;
      }
      throw err;
    }

    res.status(201).json({ token: signToken(user.id) });
  });
}

function recordFailure(email: string): void {
  const now = Date.now();
  const entry = attempts.get(email);
  if (!entry || now - entry.windowStart > LOCKOUT_MS) {
    attempts.set(email, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
  if (attempts.size > 1000) {
    for (const [key, e] of attempts) {
      if (now - e.windowStart > LOCKOUT_MS) attempts.delete(key);
    }
  }
}

function isLockedOut(email: string): boolean {
  const entry = attempts.get(email);
  return entry !== undefined && Date.now() - entry.windowStart <= LOCKOUT_MS && entry.count >= MAX_FAILED_ATTEMPTS;
}

export function loginHandler(db: DbAdapter) {
  return asyncHandler(async (req: Request, res: Response) => {
    const valid = validateCredentials(req.body?.email, req.body?.password);
    if (typeof valid === 'string') {
      res.status(400).json({ error: valid });
      return;
    }
    if (isLockedOut(valid.email)) {
      res.status(429).json({ error: 'too many failed login attempts, try again later' });
      return;
    }

    const user = await db.get<UserRow>('SELECT * FROM users WHERE email = ?', valid.email);
    if (!user || !bcrypt.compareSync(valid.password, user.password_hash)) {
      recordFailure(valid.email);
      res.status(401).json({ error: 'invalid email or password' });
      return;
    }

    res.json({ token: signToken(user.id) });
  });
}

export function changePasswordHandler(db: DbAdapter) {
  return asyncHandler(async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body ?? {};

    if (typeof currentPassword !== 'string' || !currentPassword) {
      res.status(400).json({ error: 'currentPassword is required' });
      return;
    }
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }

    const user = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', req.userId!);
    if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
      res.status(401).json({ error: 'current password is incorrect' });
      return;
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, req.userId!);
    res.json({ ok: true });
  });
}
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  try {
    const payload = jwt.verify(token, getJwtSecret());
    if (typeof payload === 'string' || typeof payload.sub !== 'string') {
      throw new Error('unrecognized token payload');
    }
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

export function meHandler(db: DbAdapter) {
  return asyncHandler(async (req: Request, res: Response) => {
    const user = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', req.userId!);
    if (!user) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    res.json({ id: user.id, email: user.email, name: user.name ?? null, createdAt: user.created_at });
  });
}

export function passwordResetRequestHandler(db: DbAdapter) {
  return (req: Request, res: Response): void => {
    const ip = req.ip ?? 'unknown';
    if (!pwResetLimiter.allow(ip)) {
      res.status(429).json({ error: 'too many reset requests, try again later' });
      return;
    }
    const email = normalizeEmail(req.body?.email);
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: 'email must be a valid email address' });
      return;
    }
    // Respond before any user lookup or email I/O: response time and body are
    // constant regardless of account existence — no enumeration side-channel.
    res.status(202).json(REQUEST_ACCEPTED);
    void deliverPasswordResetEmail(db, email).catch((err) => {
      console.error('[auth] password-reset email delivery failed:', err);
    });
  };
}

async function deliverPasswordResetEmail(db: DbAdapter, email: string): Promise<void> {
  const user = await db.get<UserRow>('SELECT * FROM users WHERE email = ?', email);
  if (!user) return;
  const token = generateToken();
  const now = Date.now();
  await db.run(
    `INSERT INTO password_reset_tokens (id, user_id, token, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    randomUUID(),
    user.id,
    token,
    new Date(now).toISOString(),
    new Date(now + PASSWORD_RESET_TTL_MS).toISOString(),
  );
  const link = `${getAppBaseUrl()}/reset-password?token=${token}`;
  await sendEmail({
    to: email,
    subject: 'Reset your Homely password',
    text: `Reset your password using this link (valid for 1 hour):\n${link}`,
    html: `<p>We received a request to reset your Homely password.</p>\n<p><a href="${link}">Reset your password</a></p>\n<p>This link is valid for 1 hour. If you didn't request this, you can ignore this email.</p>`,
  });
}

export function passwordResetConfirmHandler(db: DbAdapter) {
  return asyncHandler(async (req: Request, res: Response) => {
    const { token, newPassword } = req.body ?? {};
    if (typeof token !== 'string' || !token) {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }
    const row = await claimToken(db, 'password_reset_tokens', token);
    if (!row || !row.user_id) {
      res.status(400).json({ error: 'invalid, expired, or already used token' });
      return;
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, row.user_id);
    res.json({ ok: true });
  });
}

export function magicLinkRequestHandler(db: DbAdapter) {
  return (req: Request, res: Response): void => {
    const ip = req.ip ?? 'unknown';
    if (!magicLinkLimiter.allow(ip)) {
      res.status(429).json({ error: 'too many magic link requests, try again later' });
      return;
    }
    const email = normalizeEmail(req.body?.email);
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: 'email must be a valid email address' });
      return;
    }
    res.status(202).json(REQUEST_ACCEPTED);
    void deliverMagicLinkEmail(db, email).catch((err) => {
      console.error('[auth] magic link email delivery failed:', err);
    });
  };
}

async function deliverMagicLinkEmail(db: DbAdapter, email: string): Promise<void> {
  const user = await db.get<UserRow>('SELECT * FROM users WHERE email = ?', email);
  if (!user) return;
  const token = generateToken();
  const now = Date.now();
  await db.run(
    `INSERT INTO magic_link_tokens (id, email, token, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    randomUUID(),
    email,
    token,
    new Date(now).toISOString(),
    new Date(now + MAGIC_LINK_TTL_MS).toISOString(),
  );
  const link = `${getAppBaseUrl()}/magic-login?token=${token}`;
  await sendEmail({
    to: email,
    subject: 'Your Homely login link',
    text: `Log in to Homely using this link (valid for 15 minutes):\n${link}`,
    html: `<p>Click below to log in to Homely.</p>\n<p><a href="${link}">Log in to Homely</a></p>\n<p>This link is valid for 15 minutes and can be used once. If you didn't request it, you can ignore this email.</p>`,
  });
}

export function magicLinkConsumeHandler(db: DbAdapter) {
  return asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.body ?? {};
    if (typeof token !== 'string' || !token) {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    const row = await claimToken(db, 'magic_link_tokens', token);
    if (!row || !row.email) {
      res.status(400).json({ error: 'invalid, expired, or already used token' });
      return;
    }
    const user = await db.get<UserRow>('SELECT * FROM users WHERE email = ?', row.email);
    if (!user) {
      res.status(400).json({ error: 'invalid, expired, or already used token' });
      return;
    }
    res.json({ token: signToken(user.id) });
  });
}

export function updateNameHandler(db: DbAdapter) {
  return asyncHandler(async (req: Request, res: Response) => {
    const raw = req.body?.name;
    if (raw === undefined) {
      res.status(400).json({ error: 'name is required (string 1-100 chars, or null/empty to clear)' });
      return;
    }
    if (raw === null || raw === '') {
      await db.run('UPDATE users SET name = NULL WHERE id = ?', req.userId!);
      res.json({ ok: true, name: null });
      return;
    }
    if (typeof raw !== 'string') {
      res.status(400).json({ error: 'name must be a string or null' });
      return;
    }
    const name = raw.trim();
    if (name.length < 1 || name.length > 100) {
      res.status(400).json({ error: 'name must be 1-100 characters' });
      return;
    }
    await db.run('UPDATE users SET name = ? WHERE id = ?', name, req.userId!);
    res.json({ ok: true, name });
  });
}

export function changeEmailHandler(db: DbAdapter) {
  return asyncHandler(async (req: Request, res: Response) => {
    const { currentPassword, newEmail } = req.body ?? {};
    if (typeof currentPassword !== 'string' || !currentPassword) {
      res.status(400).json({ error: 'currentPassword is required' });
      return;
    }
    const email = normalizeEmail(newEmail);
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: 'newEmail must be a valid email address' });
      return;
    }

    const user = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', req.userId!);
    if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
      res.status(401).json({ error: 'current password is incorrect' });
      return;
    }

    if (email !== user.email) {
      const existing = await db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
      if (existing && existing.id !== user.id) {
        res.status(409).json({ error: 'email already registered' });
        return;
      }
    }

    // Scope decision: no re-verification of the new address — this system has no
    // email-verification flow anywhere (registration itself is unverified), so
    // the change is immediate for consistency. Revisit if verification is added.
    try {
      await db.run('UPDATE users SET email = ? WHERE id = ?', email, req.userId!);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'email already registered' });
        return;
      }
      throw err;
    }
    res.json({ ok: true, email });
  });
}

// Thrown inside the deletion transaction to abort with 400 before anything
// destructive has happened (the transaction rolls back — nothing was deleted).
class SoleOwnerError extends Error {}

export function deleteAccountHandler(db: DbAdapter, storage: AssetStorage) {
  return asyncHandler(async (req: Request, res: Response) => {
    const password = req.body?.password;
    if (typeof password !== 'string' || !password) {
      res.status(400).json({ error: 'password is required' });
      return;
    }
    const user = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', req.userId!);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      res.status(401).json({ error: 'password is incorrect' });
      return;
    }

    try {
      await db.transaction(async (tx) => {
        const memberships = await tx.all<{ team_id: string; role: string; name: string }>(
          `SELECT tm.team_id, tm.role, t.name
           FROM team_members tm JOIN teams t ON t.id = tm.team_id
           WHERE tm.user_id = ?`,
          req.userId!,
        );

        // Pass 1 — check ALL teams before any destructive change: a sole owner
        // of a team that still has other members cannot leave it behind.
        for (const m of memberships) {
          if (m.role !== 'owner') continue;
          const counts = await tx.get<{ owners: number; total: number }>(
            `SELECT SUM(CASE WHEN role = 'owner' THEN 1 ELSE 0 END) AS owners, COUNT(*) AS total
             FROM team_members WHERE team_id = ?`,
            m.team_id,
          );
          if (counts && counts.owners === 1 && counts.total > 1) {
            throw new SoleOwnerError(
              `you are the sole owner of team "${m.name}" — transfer ownership or remove its other members before deleting your account`,
            );
          }
        }

        // Pass 2 — team cascade. Sole owner AND sole member: the team dies with
        // the user (no one could ever access its homes again), so delete it with
        // its invites and team-owned homes rather than orphaning dangling rows.
        // Otherwise (co-owner exists, or plain member) just remove membership.
        for (const m of memberships) {
          const counts = await tx.get<{ owners: number; total: number }>(
            `SELECT SUM(CASE WHEN role = 'owner' THEN 1 ELSE 0 END) AS owners, COUNT(*) AS total
             FROM team_members WHERE team_id = ?`,
            m.team_id,
          );
          if (counts && counts.owners === 1 && counts.total === 1) {
            await tx.run('DELETE FROM team_members WHERE team_id = ?', m.team_id);
            await tx.run('DELETE FROM team_invites WHERE team_id = ?', m.team_id);
            await tx.run('DELETE FROM homes WHERE team_id = ?', m.team_id);
            await tx.run('DELETE FROM teams WHERE id = ?', m.team_id);
          } else {
            await tx.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', m.team_id, req.userId!);
          }
        }

        // Personal homes.
        await tx.run('DELETE FROM homes WHERE owner_user_id = ? AND team_id IS NULL', req.userId!);

        // Assets: DB rows + on-disk blobs, mirroring assets.ts's delete handler.
        const assets = await tx.all<{ id: string; glb_path: string; source_path: string | null }>(
          'SELECT id, glb_path, source_path FROM assets WHERE user_id = ?',
          req.userId!,
        );
        for (const a of assets) {
          storage.remove(req.userId!, a.glb_path.split('/').pop() ?? '');
          if (a.source_path) storage.remove(req.userId!, a.source_path.split('/').pop() ?? '');
        }
        await tx.run('DELETE FROM assets WHERE user_id = ?', req.userId!);

        // Hygiene: tokens/invites referencing an id/email about to stop existing.
        await tx.run('DELETE FROM password_reset_tokens WHERE user_id = ?', req.userId!);
        await tx.run('DELETE FROM magic_link_tokens WHERE email = ?', user.email);
        await tx.run('DELETE FROM team_invites WHERE invited_by_user_id = ?', req.userId!);

        // NOTE: JWTs issued before deletion stay cryptographically valid until
        // their 7-day expiry (inherent to stateless JWTs, not exploitable —
        // every DB lookup for this user 404s). Accepted limitation, out of scope.
        await tx.run('DELETE FROM users WHERE id = ?', req.userId!);
      });
    } catch (err) {
      if (err instanceof SoleOwnerError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    res.json({ ok: true });
  });
}
