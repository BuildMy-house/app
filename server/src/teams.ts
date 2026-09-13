import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler } from './asyncHandler.js';
import { requireAuth } from './auth.js';
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

export function teamsRouter(db: DbAdapter): Router {
  const router = Router();
  router.use(requireAuth);

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
      await db.transaction(async () => {
        await db.run('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)', teamId, teamName, now);
        await db.run(
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
