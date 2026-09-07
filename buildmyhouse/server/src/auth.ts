import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { Database } from 'better-sqlite3';
import type { NextFunction, Request, Response } from 'express';
import { getJwtSecret } from './config.js';
import type { UserRow } from './db.js';

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
    (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  );
}

export function registerHandler(db: Database) {
  return (req: Request, res: Response): void => {
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

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(valid.email);
    if (existing) {
      res.status(409).json({ error: 'email already registered' });
      return;
    }

    const user: UserRow = {
      id: randomUUID(),
      email: valid.email,
      password_hash: bcrypt.hashSync(valid.password, 10),
      created_at: new Date().toISOString(),
    };
    try {
      db.prepare(
        `INSERT INTO users (id, email, password_hash, created_at)
         VALUES (@id, @email, @password_hash, @created_at)`,
      ).run(user);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'email already registered' });
        return;
      }
      throw err;
    }

    res.status(201).json({ token: signToken(user.id) });
  };
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

export function loginHandler(db: Database) {
  return (req: Request, res: Response): void => {
    const valid = validateCredentials(req.body?.email, req.body?.password);
    if (typeof valid === 'string') {
      res.status(400).json({ error: valid });
      return;
    }
    if (isLockedOut(valid.email)) {
      res.status(429).json({ error: 'too many failed login attempts, try again later' });
      return;
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(valid.email) as UserRow | undefined;
    if (!user || !bcrypt.compareSync(valid.password, user.password_hash)) {
      recordFailure(valid.email);
      res.status(401).json({ error: 'invalid email or password' });
      return;
    }

    res.json({ token: signToken(user.id) });
  };
}

export function changePasswordHandler(db: Database) {
  return (req: Request, res: Response): void => {
    const { currentPassword, newPassword } = req.body ?? {};

    if (typeof currentPassword !== 'string' || !currentPassword) {
      res.status(400).json({ error: 'currentPassword is required' });
      return;
    }
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId!) as UserRow | undefined;
    if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
      res.status(401).json({ error: 'current password is incorrect' });
      return;
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.userId!);
    res.json({ ok: true });
  };
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