import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler } from './asyncHandler.js';
import { requireAuth } from './auth.js';
import { getAppBaseUrl, sendEmail } from './email.js';
import type { DbAdapter } from './db.js';

interface TeamRow {
  id: string;
  name: string;
  created_at: string;
}

interface TeamMemberRow {
  team_id: string;
  user_id: string;
  role: string;
  joined_at: string;
}

interface TeamInviteRow {
  id: string;
  team_id: string;
  email: string;
  role: string;
  invited_by_user_id: string;
  token: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

// Mirrors auth.ts's isUniqueViolation (not exported there): SQLITE_CONSTRAINT
// for better-sqlite3, 23505 for Postgres.
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

export function teamsRouter(db: DbAdapter): Router {
  const router = Router();

  // GET /api/teams/invites/:token — PUBLIC (no auth): the invitee may not have
  // an account yet. Returns enough for a frontend to show "You've been invited
  // to X". Registered before requireAuth so it shadows GET /:id.
  router.get(
    '/invites/:token',
    asyncHandler(async (req: Request, res: Response) => {
      const invite = await db.get<TeamInviteRow & { team_name: string }>(
        `SELECT ti.*, t.name AS team_name
         FROM team_invites ti
         JOIN teams t ON t.id = ti.team_id
         WHERE ti.token = ?`,
        req.params.token!,
      );
      if (!invite) {
        res.status(404).json({ error: 'invite not found' });
        return;
      }
      if (invite.accepted_at !== null || invite.expires_at < new Date().toISOString()) {
        res.status(410).json({ error: 'invite is no longer valid' });
        return;
      }
      res.json({ teamName: invite.team_name, invitedEmail: invite.email, role: invite.role });
    }),
  );

  router.use(requireAuth);

  // POST /api/teams/:id/invites — email-invite someone to the team (owner-only).
  // Works whether or not the invitee has an account yet.
  router.post(
    '/:id/invites',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.userId!;
      const teamId = req.params.id!;
      const body = (req.body ?? {}) as { email?: unknown; role?: unknown };
      if (typeof body.email !== 'string' || !body.email.trim()) {
        res.status(400).json({ error: 'email is required' });
        return;
      }
      const role = typeof body.role === 'string' && body.role ? body.role : 'member';
      if (role !== 'member' && role !== 'owner') {
        res.status(400).json({ error: 'role must be member or owner' });
        return;
      }

      const team = await db.get<TeamRow>('SELECT id, name FROM teams WHERE id = ?', teamId);
      if (!team) {
        res.status(404).json({ error: 'team not found' });
        return;
      }

      const callerMembership = await db.get<TeamMemberRow>(
        'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?',
        teamId,
        userId,
      );
      if (!callerMembership || callerMembership.role !== 'owner') {
        res.status(403).json({ error: 'only owners can invite members' });
        return;
      }

      const inviteEmail = body.email.trim().toLowerCase();
      const existingMember = await db.get<{ '1': number }>(
        `SELECT 1 FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = ? AND u.email = ?`,
        teamId,
        inviteEmail,
      );
      if (existingMember) {
        res.status(409).json({ error: 'user is already a member' });
        return;
      }

      const inviteId = randomUUID();
      const token = randomUUID();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await db.run(
        `INSERT INTO team_invites (id, team_id, email, role, invited_by_user_id, token, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        inviteId,
        teamId,
        inviteEmail,
        role,
        userId,
        token,
        now,
        expiresAt,
      );

      const link = `${getAppBaseUrl()}/invite?token=${token}`;
      const esc = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      await sendEmail({
        to: inviteEmail,
        subject: "You've been invited to a Homely team",
        html:
          `<p>You've been invited to join <strong>${esc(team.name)}</strong> on Homely.</p>` +
          `<p><a href="${link}">Accept the invitation</a></p>`,
        text: `You've been invited to join ${team.name} on Homely. Accept: ${link}`,
      });

      // Token deliberately omitted from the response — it only leaves via email.
      res.status(201).json({ id: inviteId, email: inviteEmail, role, expiresAt });
    }),
  );

  // POST /api/teams/invites/:token/accept — accept an invite. The caller's own
  // account email must match the invite's email so a link can't be cashed by
  // whoever happens to be logged in.
  router.post(
    '/invites/:token/accept',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.userId!;
      const invite = await db.get<TeamInviteRow & { team_name: string }>(
        `SELECT ti.*, t.name AS team_name
         FROM team_invites ti
         JOIN teams t ON t.id = ti.team_id
         WHERE ti.token = ?`,
        req.params.token!,
      );
      if (!invite) {
        res.status(404).json({ error: 'invite not found' });
        return;
      }
      if (invite.expires_at < new Date().toISOString()) {
        res.status(410).json({ error: 'invite has expired' });
        return;
      }

      const user = await db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', userId);
      if (!user || user.email.toLowerCase() !== invite.email.toLowerCase()) {
        res.status(403).json({ error: 'this invite was sent to a different email address' });
        return;
      }

      const alreadyMember = await db.get<{ '1': number }>(
        'SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?',
        invite.team_id,
        userId,
      );
      if (alreadyMember) {
        res.status(409).json({ error: 'user is already a member' });
        return;
      }

      // Atomically claim the invite (mirrors auth.ts's claimToken pattern): the
      // same UPDATE that flips accepted_at also checks non-reuse and expiry, so
      // of two concurrent accepts only one ever reaches the insert below.
      const now = new Date().toISOString();
      const claim = await db.run(
        'UPDATE team_invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND expires_at > ?',
        now,
        invite.id,
        now,
      );
      if (claim.changes === 0) {
        res.status(410).json({ error: 'invite has already been accepted' });
        return;
      }

      try {
        await db.transaction(async (tx) => {
          await tx.run(
            'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
            invite.team_id,
            userId,
            invite.role,
            now,
          );
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          res.status(409).json({ error: 'user is already a member' });
          return;
        }
        throw err;
      }
      res
        .status(200)
        .json({ ok: true, teamId: invite.team_id, teamName: invite.team_name, role: invite.role });
    }),
  );

  // POST /api/teams — create a team; creator becomes owner
  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.userId!;
      const { name } = (req.body ?? {}) as { name?: unknown };
      const teamName = typeof name === 'string' && name.trim() ? name.trim() : '';
      if (!teamName) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const teamId = randomUUID();
      const now = new Date().toISOString();
      await db.transaction(async (tx) => {
        await tx.run('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)', teamId, teamName, now);
        await tx.run(
          'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
          teamId,
          userId,
          'owner',
          now,
        );
      });
      res.status(201).json({ id: teamId, name: teamName, createdAt: now });
    }),
  );

  // GET /api/teams — list teams the authenticated user belongs to
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.userId!;
      const rows = await db.all<TeamRow & { role: string }>(
        `SELECT t.id, t.name, t.created_at, tm.role
         FROM teams t
         JOIN team_members tm ON tm.team_id = t.id
         WHERE tm.user_id = ?
         ORDER BY t.created_at DESC`,
        userId,
      );
      res.json({
        items: rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, role: r.role })),
      });
    }),
  );

  // GET /api/teams/:id — team detail + member list
  router.get(
    '/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.userId!;
      const team = await db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', req.params.id!);
      if (!team) {
        res.status(404).json({ error: 'team not found' });
        return;
      }
      const membership = await db.get<TeamMemberRow>(
        'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?',
        team.id,
        userId,
      );
      if (!membership) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const members = await db.all<{ email: string; role: string; joined_at: string }>(
        `SELECT u.email, tm.role, tm.joined_at
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = ?
         ORDER BY tm.joined_at`,
        team.id,
      );
      res.json({
        id: team.id,
        name: team.name,
        createdAt: team.created_at,
        members: members.map((m) => ({ email: m.email, role: m.role, joinedAt: m.joined_at })),
      });
    }),
  );

  // POST /api/teams/:id/members — add a member by email (owner-only)
  router.post(
    '/:id/members',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.userId!;
      const teamId = req.params.id!;
      const { email } = (req.body ?? {}) as { email?: unknown };
      if (typeof email !== 'string' || !email.trim()) {
        res.status(400).json({ error: 'email is required' });
        return;
      }

      const team = await db.get<TeamRow>('SELECT id FROM teams WHERE id = ?', teamId);
      if (!team) {
        res.status(404).json({ error: 'team not found' });
        return;
      }

      const callerMembership = await db.get<TeamMemberRow>(
        'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?',
        teamId,
        userId,
      );
      if (!callerMembership || callerMembership.role !== 'owner') {
        res.status(403).json({ error: 'only owners can add members' });
        return;
      }

      const targetUser = await db.get<{ id: string }>(
        'SELECT id FROM users WHERE email = ?',
        email.trim().toLowerCase(),
      );
      if (!targetUser) {
        res.status(404).json({ error: 'user not found' });
        return;
      }

      const existing = await db.get<{ '1': number }>(
        'SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?',
        teamId,
        targetUser.id,
      );
      if (existing) {
        res.status(409).json({ error: 'user is already a member' });
        return;
      }

      const now = new Date().toISOString();
      await db.run(
        'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
        teamId,
        targetUser.id,
        'member',
        now,
      );
      res.status(201).json({ ok: true });
    }),
  );

  // DELETE /api/teams/:id/members/:userId — remove a member (owner or self-leave)
  router.delete(
    '/:id/members/:memberId',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.userId!;
      const teamId = req.params.id!;
      const memberId = req.params.memberId!;

      const team = await db.get<TeamRow>('SELECT id FROM teams WHERE id = ?', teamId);
      if (!team) {
        res.status(404).json({ error: 'team not found' });
        return;
      }

      const targetMembership = await db.get<TeamMemberRow>(
        'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?',
        teamId,
        memberId,
      );
      if (!targetMembership) {
        res.status(404).json({ error: 'member not found' });
        return;
      }

      // Owner can remove anyone; member can only remove themselves
      const callerMembership = await db.get<TeamMemberRow>(
        'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?',
        teamId,
        userId,
      );
      if (!callerMembership) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (callerMembership.role !== 'owner' && userId !== memberId) {
        res.status(403).json({ error: 'only owners can remove other members' });
        return;
      }

      // Prevent removing the last owner
      if (targetMembership.role === 'owner') {
        const ownerCount = await db.get<{ cnt: number }>(
          'SELECT COUNT(*) as cnt FROM team_members WHERE team_id = ? AND role = ?',
          teamId,
          'owner',
        );
        if ((ownerCount?.cnt ?? 0) <= 1) {
          res.status(400).json({ error: 'cannot remove the last owner' });
          return;
        }
      }

      await db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, memberId);
      res.status(204).end();
    }),
  );

  return router;
}

/**
 * Check if a user is a member of a team. Used by homes router for team-based access.
 */
export async function isTeamMember(db: DbAdapter, teamId: string, userId: string): Promise<boolean> {
  const row = await db.get<{ '1': number }>(
    'SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?',
    teamId,
    userId,
  );
  return row !== undefined;
}
