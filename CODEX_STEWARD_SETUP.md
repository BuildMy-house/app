# Codex + Steward ACS Setup

Configure Cursor/Codex IDE to work with Steward for agent coordination on house_designer.

## Setup Steps

### 1. Locate Cursor Settings

**macOS:**
```
~/.cursor/mcp.json
```

**Linux:**
```
~/.config/Cursor/User/settings.json
```

**Windows:**
```
%APPDATA%\Cursor\User\settings.json
```

### 2. Add Steward MCP Configuration

Add this to your Cursor MCP configuration (or create `~/.cursor/mcp.json` if it doesn't exist):

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

### 3. Restart Cursor

Close and reopen Cursor. Steward MCP should now be available.

### 4. Verify Connection

In Cursor's Claude chat, test:
```
@steward help
```

If successful, you'll see Steward's available commands.

## Workflow: Claiming Work in Cursor

Once configured, you can use Steward directly from Cursor:

```
@steward claim_work(task_id="T1.2")
@steward lock_file(task_id="T1.2", files=["homely/src/core/model.ts"])
# ... make your changes ...
@steward save_memory(title="Pattern learned", content="...", scope="project")
@steward release_work(task_id="T1.2")
```

## Full Coordination Protocol

See `AGENTS_STEWARD.md` in the repo root for the complete multi-agent workflow.

### Quick Reference

1. **Claim work** → `create_work()` or `claim_work(task_id)`
2. **Lock files** → `lock_file(task_id, files=[...])`
3. **Implement & verify** (see AGENTS_STEWARD.md for E2E tests)
4. **Save learnings** → `save_memory(...)`
5. **Release** → `release_work(task_id)`

## Troubleshooting

**"Steward not found" error:**
- Restart Cursor after adding MCP config
- Check that the API key is correct

**"Authorization failed":**
- Verify the API key hasn't been revoked
- Check that the Bearer token is complete

**Connection timeout:**
- Verify network access to `buildmyhouse.stewardacs.xyz`
- Check if VPN/firewall is blocking the connection

## Available Steward Commands

When Steward MCP is connected, you can:

- `create_work(title, description, claim, agent_id)` — create & claim a task
- `claim_work(task_id, agent_id)` — claim existing task
- `release_work(task_id, learned_for_agents, improvements)` — release with feedback
- `lock_file(task_id, files, repo_confirmed)` — lock files for editing
- `save_memory(title, content, scope, about, visibility)` — save project knowledge
- `query_memories(query, scope, about, status)` — search memories
- `generate_guidance_packet(scope, task_id)` — get task-specific guidance

Full MCP tool documentation at `.claude/agents/steward.md`.
