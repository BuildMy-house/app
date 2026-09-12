---
name: steward
description: Connect to Steward ACS memory and agent coordination system at buildmyhouse.stewardacs.xyz. Use for saving/querying project memories, retrieving agent guidance, and coordinating multi-agent work. Steward is the source of truth for house_designer team knowledge.
tools: WebFetch, WebSearch
model: inherit
---

# Steward MCP — house_designer Project Memory & Agent Coordination

Steward ACS (Agent Coordination System) is the persistent knowledge layer for the house_designer project. It stores:
- **Project memories** — decisions, patterns, non-obvious insights, architecture notes
- **Agent guidance** — scope/task-specific instructions for work
- **Memory ledger** — provenance of who created/updated what, when
- **Task coordination** — claim/lock/release workflow for multi-agent work

## Connection Details

**Endpoint:** `https://buildmyhouse.stewardacs.xyz/mcp/sse`  
**Project:** house_designer (Homely — Tauri clone of Sweet Home 3D)  
**Auth:** Developer API Key  
**Dev API Key:** `acs_dev_60621d2e247441a5fa2bbebd593658a1ade3205e0ca6554b5c28b8b257ff9c65`

### For Different Agents

**Claude Code (Claude CLI):** Configured in `.claude/mcp.json` (Bearer token)  
**OpenCode (worker agents):** Configured in `~/.opencode/config.json` (Bearer token)  
**Codex/Cursor (IDE):** Add to `.mcp.json` or IDE workspace settings (Bearer token)  
**Hermees (in-container Claude):** Use env var `STEWARD_API_KEY=acs_dev_60621d2e247441a5fa2bbebd593658a1ade3205e0ca6554b5c28b8b257ff9c65`

## Coordination Protocol

See `AGENTS_STEWARD.md` in repo root for the full multi-agent workspace protocol.

**Quick workflow per ticket:**
1. **Claim** → `create_work(title="<ticket>", claim=true)`
2. **Lock files** → `lock_file(task_id="...", files=[...])`
3. **Implement & verify**
4. **Save learnings** → `save_memory(...)` / `skill_save(...)`
5. **Release & submit feedback** → `release_work()` → `submit_task_feedback(...)`

## Available Memory Tools

When connected to Steward, you have access to:

### `save_memory(title, content, scope, ...)`
Create a new memory in Steward's knowledge base.

- `title` (string, required) — short name
- `content` (string, required) — full description, patterns, constraints
- `scope` (string) — "project", "architecture", "decision", "pattern", "debugging", "testing"
- `about` (string) — what this memory covers
- `visibility` (string) — "public", "internal", "private"

### `query_memories(query, scope, about, status)`
Search and retrieve memories from Steward.

### `update_memory(id, title, content, status)`
Revise an existing memory or change its lifecycle status.

### `set_memory_status(id, status)`
Update memory status: approved, rejected, stale, deprecated

### `generate_guidance_packet(scope, task_id)`
Retrieve curated guidance for a specific scope or task.

### `create_work(title, description, claim, agent_id)`
Create and optionally claim a new task in the board.

### `claim_work(task_id, agent_id)`
Claim ownership of an existing task.

### `release_work(task_id, learned_for_agents, improvements)`
Release a task you claimed, unlocking files and submitting feedback.

### `lock_file(task_id, files, repo_confirmed)`
Lock files during work to prevent conflicts with other agents.

## Key Project Memories to Review Before Starting

Before starting work on a ticket, query Steward for guidance:

```
query_memories({
  scope: "project",
  query: "architecture decisions for this feature area"
})
```

## Current Session Status

This agent file enables you to call Steward memory tools when working on house_designer. The Steward instance at buildmyhouse.stewardacs.xyz is the source of truth for all project state.

**When to save learnings:**
- After discovering a gotcha or non-obvious pattern
- After debugging something and finding the root cause
- When you validate an architectural assumption
- After verifying the DoD for a ticket

**Example:**
```
save_memory({
  title: "E2E test verification is mandatory for UI changes",
  scope: "testing",
  content: "All changes to src/main.ts, src/ui/, src/style.css, src/view3d/, src/render/, or src/plan/ must pass npm run e2e before committing. Unit tests alone are insufficient. See AGENTS_STEWARD.md for full test matrix.",
  about: "UI testing",
  visibility: "internal"
})
```

The memory system is the connective tissue across sessions—use it liberally.
