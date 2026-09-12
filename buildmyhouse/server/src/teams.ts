import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { Request, Response } from 'express';
import { requireAuth } from './auth.js';

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

export function teamsRouter(db: Database): Router {
  const router = Router();
  router.use(requireAuth);

  // POST /api/teams — create a team; creator becomes owner
  router.post('/', (req: Request, res: Response) => {
    const userId = req.userId!;
    const { name } = (req.body ?? {}) as { name?: unknown };
    const teamName = typeof name === 'string' && name.trim() ? name.trim() : '';
    if (!teamName) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const teamId = randomUUID();
    const now = new Date().toISOString();
    const createTeam = db.transaction(() => {
      db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').run(teamId, teamName, now);
      db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(teamId, userId, 'owner', now);
    });
    createTeam();
    res.status(201).json({ id: teamId, name: teamName, createdAt: now });
  });

  // GET /api/teams — list teams the authenticated user belongs to
  router.get('/', (req: Request, res: Response) => {
    const userId = req.userId!;
    const rows = db
      .prepare(
        `SELECT t.id, t.name, t.created_at, tm.role
         FROM teams t
         JOIN team_members tm ON tm.team_id = t.id
         WHERE tm.user_id = ?
         ORDER BY t.created_at DESC`,
      )
      .all(userId) as (TeamRow & { role: string })[];
    res.json({
      items: rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, role: r.role })),
    });
  });

  // GET /api/teams/:id — team detail + member list
  router.get('/:id', (req: Request, res: Response) => {
    const userId = req.userId!;
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id!) as TeamRow | undefined;
    if (!team) {
      res.status(404).json({ error: 'team not found' });
      return;
    }
    const membership = db
      .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
      .get(team.id, userId) as TeamMemberRow | undefined;
    if (!membership) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const members = db
      .prepare(
        `SELECT u.email, tm.role, tm.joined_at
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = ?
         ORDER BY tm.joined_at`,
      )
      .all(team.id) as { email: string; role: string; joined_at: string }[];
    res.json({
      id: team.id,
      name: team.name,
      createdAt: team.created_at,
      members: members.map((m) => ({ email: m.email, role: m.role, joinedAt: m.joined_at })),
    });
  });

  // POST /api/teams/:id/members — add a member by email (owner-only)
  router.post('/:id/members', (req: Request, res: Response) => {
    const userId = req.userId!;
    const teamId = req.params.id!;
    const { email } = (req.body ?? {}) as { email?: unknown };
    if (typeof email !== 'string' || !email.trim()) {
      res.status(400).json({ error: 'email is required' });
      return;
    }

    const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId) as TeamRow | undefined;
    if (!team) {
      res.status(404).json({ error: 'team not found' });
      return;
    }

    const callerMembership = db
      .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
      .get(teamId, userId) as TeamMemberRow | undefined;
    if (!callerMembership || callerMembership.role !== 'owner') {
      res.status(403).json({ error: 'only owners can add members' });
      return;
    }

    const targetUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase()) as { id: string } | undefined;
    if (!targetUser) {
      res.status(404).json({ error: 'user not found' });
      return;
    }

    const existing = db
      .prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?')
      .get(teamId, targetUser.id);
    if (existing) {
      res.status(409).json({ error: 'user is already a member' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(teamId, targetUser.id, 'member', now);
    res.status(201).json({ ok: true });
  });

  // DELETE /api/teams/:id/members/:userId — remove a member (owner or self-leave)
  router.delete('/:id/members/:memberId', (req: Request, res: Response) => {
    const userId = req.userId!;
    const teamId = req.params.id!;
    const memberId = req.params.memberId!;

    const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId) as TeamRow | undefined;
    if (!team) {
      res.status(404).json({ error: 'team not found' });
      return;
    }

    const targetMembership = db
      .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
      .get(teamId, memberId) as TeamMemberRow | undefined;
    if (!targetMembership) {
      res.status(404).json({ error: 'member not found' });
      return;
    }

    // Owner can remove anyone; member can only remove themselves
    const callerMembership = db
      .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
      .get(teamId, userId) as TeamMemberRow | undefined;
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
      const ownerCount = db
        .prepare('SELECT COUNT(*) as cnt FROM team_members WHERE team_id = ? AND role = ?')
        .get(teamId, 'owner') as { cnt: number };
      if (ownerCount.cnt <= 1) {
        res.status(400).json({ error: 'cannot remove the last owner' });
        return;
      }
    }

    db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, memberId);
    res.status(204).end();
  });

  return router;
}

/**
 * Check if a user is a member of a team. Used by homes router for team-based access.
 */
export function isTeamMember(db: Database, teamId: string, userId: string): boolean {
  const row = db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
  return row !== undefined;
}
