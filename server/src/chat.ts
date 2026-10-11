import type { RequestHandler } from 'express';
import { asyncHandler } from './asyncHandler.js';

/** Max time to wait on pm-agent before answering 503. */
export const PM_AGENT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_LENGTH = 4000;

/**
 * POST /api/chat — authenticated JSON relay to pm-agent's `POST /chat`.
 *
 * The user id sent upstream is ALWAYS `req.userId` (set by `requireAuth` from
 * the verified JWT); any user id in the client body is ignored. The target
 * comes from `PM_AGENT_URL`, read per request; unset/unreachable => 503.
 * When `PM_AGENT_AUTH_TOKEN` is set it is sent as `Authorization: Bearer` (must
 * match pm-agent's own `PM_AGENT_AUTH_TOKEN`); unset => no auth header.
 */
export function chatHandler(): RequestHandler {
  return asyncHandler(async (req, res) => {
    const base = process.env.PM_AGENT_URL?.trim();
    if (!base) {
      res.status(503).json({ error: 'Chat is not configured' });
      return;
    }
    const message = (req.body as { message?: unknown } | undefined)?.message;
    if (typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: 'message is too long' });
      return;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const authToken = process.env.PM_AGENT_AUTH_TOKEN?.trim();
    if (authToken) headers.Authorization = `Bearer ${authToken}`;

    let upstream: Response;
    try {
      upstream = await fetch(`${base.replace(/\/+$/, '')}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ app_user_id: req.userId, message }),
        signal: AbortSignal.timeout(PM_AGENT_TIMEOUT_MS),
      });
    } catch {
      res.status(503).json({ error: 'Chat service unavailable' });
      return;
    }
    if (!upstream.ok) {
      res.status(upstream.status >= 500 ? 503 : 502).json({ error: 'Chat service error' });
      return;
    }
    const data = (await upstream.json().catch(() => null)) as { reply?: unknown } | null;
    if (!data || typeof data.reply !== 'string') {
      res.status(502).json({ error: 'Chat service returned an invalid reply' });
      return;
    }
    res.json({ reply: data.reply });
  });
}
