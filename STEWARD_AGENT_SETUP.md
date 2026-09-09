# Steward ACS Setup for All Agents

This document ensures all agents in the house_designer ecosystem are configured to coordinate through Steward ACS.

## TL;DR — Configuration Status

| Agent | Config File | Status |
|---|---|---|
| **Claude Code (CLI)** | `.claude/mcp.json` | ✅ Configured |
| **OpenCode Worker** | `~/.opencode/config.json` | ✅ Configured |
| **Codex Worker** | `.codex/config.json` | ✅ Configured |
| **Hermees Container (in-process agents)** | `hermees/Dockerfile` | ✅ Configured |

**API Key (all agents):**
```
acs_dev_60621d2e247441a5fa2bbebd593658a1ade3205e0ca6554b5c28b8b257ff9c65
```

**Endpoint (all agents):**
```
https://buildmyhouse.stewardacs.xyz/mcp/sse
```

---

## 1. Claude Code (CLI) — `.claude/mcp.json`

**Status:** ✅ Already configured

Claude Code (this session) connects to Steward via `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "steward": {
      "url": "https://buildmyhouse.stewardacs.xyz/mcp/sse",
      "type": "sse",
      "headers": {
        "Authorization": "Bearer acs_dev_60621d2e247441a5fa2bbebd593658a1ade3205e0ca6554b5c28b8b257ff9c65"
      }
    }
  }
}
```

**Usage:** Use `@steward` in Claude Code commands to claim/lock/release work.

---

## 2. OpenCode Worker — `~/.opencode/config.json`

**Status:** ✅ Already configured

OpenCode (delegated worker) connects to Steward via home config:

```json
{
  "model": "opencode/mimo-v2.5-free",
  "mcp": {
    "steward": {
      "type": "remote",
      "url": "https://buildmyhouse.stewardacs.xyz/mcp/sse",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer acs_dev_60621d2e247441a5fa2bbebd593658a1ade3205e0ca6554b5c28b8b257ff9c65"
      }
    }
  }
}
```

**Usage:** When dispatching tickets to OpenCode, it can autonomously claim/lock/release work in Steward.

---

## 3. Codex Worker — `.codex/config.json`

**Status:** ✅ Just configured

Codex (delegated worker) connects to Steward via project config:

```json
{
  "model": "gpt-4-turbo",
  "mcp": {
    "steward": {
      "type": "remote",
      "url": "https://buildmyhouse.stewardacs.xyz/mcp/sse",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer acs_dev_60621d2e247441a5fa2bbebd593658a1ade3205e0ca6554b5c28b8b257ff9c65"
      }
    }
  }
}
```

**Usage:** When dispatching tickets to Codex, it can autonomously claim/lock/release work in Steward.

---

## 4. Hermees Container — `hermees/Dockerfile`

**Status:** ✅ Just configured

In-container agents (Claude running inside Hermees) access Steward via environment variables:

```dockerfile
ENV STEWARD_API_KEY=acs_dev_60621d2e247441a5fa2bbebd593658a1ade3205e0ca6554b5c28b8b257ff9c65
ENV STEWARD_URL=https://buildmyhouse.stewardacs.xyz/mcp/sse
```

**Usage:** When Claude runs inside the Hermees container, it can read these env vars to construct MCP calls to Steward.

### For docker-compose users:

If you use `docker-compose.yml`, ensure these are passed through:

```yaml
services:
  hermees:
    build: ./hermees
    environment:
      - STEWARD_API_KEY=acs_dev_60621d2e247441a5fa2bbebd593658a1ade3205e0ca6554b5c28b8b257ff9c65
      - STEWARD_URL=https://buildmyhouse.stewardacs.xyz/mcp/sse
```

Or set them in a `.env` file and pass via `--env-file`:

```bash
docker run --env-file .env -it hermees:latest
```

---

## Coordination Workflow

Every agent now follows the same Steward lifecycle:

1. **Claim** → `create_work(title, claim=true)` or `claim_work(task_id)`
2. **Lock** → `lock_file(task_id, files=[...])`
3. **Implement & Verify** (follow AGENTS_STEWARD.md)
4. **Save Learnings** → `save_memory(...)` / `skill_save(...)`
5. **Release** → `release_work(task_id, learned_for_agents="...")`
6. **Submit Feedback** → `submit_task_feedback(...)`

---

## Verification

To verify all agents are Steward-ready:

### Claude Code
```bash
cd /home/nahar/Documents/code/house_designer
cat .claude/mcp.json | grep -q steward && echo "✅ Claude Code ready"
```

### OpenCode
```bash
cat ~/.opencode/config.json | jq '.mcp.steward' && echo "✅ OpenCode ready"
```

### Codex
```bash
cat /home/nahar/Documents/code/house_designer/.codex/config.json | jq '.mcp.steward' && echo "✅ Codex ready"
```

### Hermees
```bash
grep "STEWARD_API_KEY" /home/nahar/Documents/code/house_designer/hermees/Dockerfile && echo "✅ Hermees ready"
```

---

## When to Use Each Agent

| Agent | Best For | Key Benefit |
|---|---|---|
| **Claude Code** | Ad-hoc commands, manager role, small edits | Direct access, full context |
| **OpenCode** | Routine implementation work, batched tickets | Cost-effective, parallelizable |
| **Codex** | Complex/ambiguous tickets, hard reasoning | Highest capability tier |
| **Hermees (in-container)** | Background services, async work | Isolated, long-running |

---

## Troubleshooting

**Agent can't reach Steward:**
- Check network access to `buildmyhouse.stewardacs.xyz`
- Verify API key hasn't been revoked
- Run a test: `curl -H "Authorization: Bearer <KEY>" https://buildmyhouse.stewardacs.xyz/mcp/sse`

**"Authorization failed" errors:**
- Double-check the Bearer token is complete and not truncated
- Verify it matches `acs_dev_60621d2e247441a5fa2bbebd593658a1ade3205e0ca6554b5c28b8b257ff9c65`

**Container can't find env vars:**
- Rebuild: `docker build -t hermees:latest ./hermees`
- Verify: `docker run --rm hermees:latest env | grep STEWARD`

---

## See Also

- `AGENTS_STEWARD.md` — Full multi-agent coordination protocol
- `.claude/agents/steward.md` — Steward MCP reference
- `PLAN.md` — Live claim board for all tickets
