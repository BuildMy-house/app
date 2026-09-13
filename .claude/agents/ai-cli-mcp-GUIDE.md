# ai-cli-mcp Setup & Usage Guide

**Reference:** Unified dispatch routing for Claude/Codex/OpenCode through a single interface with cost optimization and async background job management.

## Installation

```bash
npm install -g ai-cli-mcp
ai-cli --version          # Verify: v2.23.0+
ai-cli doctor             # Verify available backends (claude, codex, opencode)
```

## Configuration

**File:** `~/.config/ai-cli/config.toml`

```toml
[worker.cheap]
agent = "opencode"
model = "oc-opencode/big-pickle"
timeout_seconds = 300
description = "Free tier, default for mechanical tasks"

[worker.balanced]
agent = "opencode"
model = "oc-opencode/mimo-v2.5-free"
timeout_seconds = 300
description = "Free tier, can stall on 30-50+ tool calls"

[worker.hard]
agent = "claude"
model = "opus"
timeout_seconds = 900
description = "Claude Opus, highest capability, real per-token cost"

[worker.quick]
agent = "opencode"
model = "oc-opencode/nemotron-3-ultra-free"
timeout_seconds = 180
description = "Free tier, fast alternative"

[default]
worker = "cheap"
mcp_server_port = 3001
logging_level = "info"
```

## Local Development Usage

### Single Dispatch

```bash
cd /tmp
ai-cli run \
  --cwd /home/nahar/Documents/code/house_designer \
  --model oc-opencode/big-pickle \
  --prompt "Your ticket text here"
```

### Job Management

```bash
ai-cli ps                    # List running/completed jobs
ai-cli result <pid>          # Fetch result for job PID
ai-cli wait <pid>            # Block until job completes
ai-cli kill <pid>            # Terminate job
ai-cli cleanup               # Remove completed/failed jobs
```

### Concurrent Dispatch (Multiple Workers)

```bash
# Launch 3 jobs concurrently
PID1=$(ai-cli run ... --model oc-opencode/big-pickle ... | jq .pid)
PID2=$(ai-cli run ... --model oc-opencode/mimo-v2.5-free ... | jq .pid)
PID3=$(ai-cli run ... --model claude:opus ... | jq .pid)

# Poll for completion
until ai-cli ps | jq -r '.[] | select(.status != "completed") | .pid' | grep -q .; do
  sleep 2
done

# Collect results
ai-cli result $PID1
ai-cli result $PID2
ai-cli result $PID3
```

## Container Setup (Engineering Container)

The same ai-cli-mcp setup works in the engineering container, allowing agent-manager to dispatch from within Docker.

### Dockerfile Configuration

Add to `company-ops/Dockerfile.engineering`:

```dockerfile
# Install ai-cli-mcp globally
RUN npm install -g ai-cli-mcp@latest

# Ensure config directory exists
RUN mkdir -p ~/.config/ai-cli
```

### Config Volume Mount

In `company-ops/docker-compose.yml`:

```yaml
services:
  engineering:
    volumes:
      # Bind-mount host config into container
      - ~/.config/ai-cli:/root/.config/ai-cli
```

Or seed config at build time:

```dockerfile
COPY company-ops/ai-cli-config.toml /root/.config/ai-cli/config.toml
```

### Environment Variables (Container)

```yaml
environment:
  # Pass through API keys for balanced/hard tiers
  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
  CODEX_API_KEY: ${CODEX_API_KEY}
```

## Usage Patterns for Agent-Manager Dispatch

### Cost-Aware Selection

| Tier | Use When | Cost | Latency |
|------|----------|------|---------|
| **cheap** | Routine work, mechanical tasks, mechanical code changes | $0 | 5-30s |
| **quick** | Cheap tier stalled, need faster result | ~$0.05/1M | 2-20s |
| **balanced** | Uncertain ticket, moderate complexity | Free (OpenCode) or $0 (Claude) | 10-60s |
| **hard** | Genuinely ambiguous, high-impact, cross-cutting design | $5/$25 per 1M | 20-90s |

### Dispatch Patterns

**Default (Cheap):**
```bash
ai-cli run --cwd <repo> --model oc-opencode/big-pickle --prompt "<ticket>"
```

**Escalate to Balanced (if cheap seems insufficient):**
```bash
ai-cli run --cwd <repo> --model oc-opencode/mimo-v2.5-free --prompt "<ticket>"
```

**Last Resort (High Capability):**
```bash
ai-cli run --cwd <repo> --model claude:opus --prompt "<ticket>"
```

## Cost Tracking

### Reading Token Output

```bash
ai-cli result <pid> | jq '.agentOutput.tokens'
# Returns: { "total": 10000, "input": 9000, "output": 1000, "reasoning": 0, "cache": { "read": 5000, "write": 0 } }
```

### Cost Calculation by Tier

- **Free tiers (opencode/big-pickle, mimo-v2.5-free, nemotron, etc.)**: $0
- **opencode-go (when available)**: ~$0.05-0.15 per 1M input tokens (shared $30/week budget)
- **Claude Opus**: $5.00 input + $25.00 output per 1M tokens

**Example:** 9000 input + 1000 output on Claude Opus
```
Cost = (9000 * 5 + 1000 * 25) / 1000000 = 0.070 dollars = $0.07
```

## Quota & Budget Awareness

### Known Quota Walls

| Provider | Limit | Status (2026-09-08) | Recovery |
|----------|-------|------------|----------|
| **opencode-go** | $30/week + monthly cap | EXHAUSTED (monthly, resets 2026-09-26) | Use free tiers |
| **opencode free** | ~12 dispatches/day | Operational | Wait 30min or use another tier |
| **Claude API** | Per-account billing | Depends on account | Check `ANTHROPIC_API_KEY` |
| **Codex** | ChatGPT subscription quota | Requires `codex login` | Auth persistent |

### Checking Quota Status

```bash
# Check opencode logs for quota walls
tail -50 ~/.local/share/opencode/log/opencode.log | grep -i "limit\|usage"

# Example output to watch for:
# "Weekly usage limit reached"
# "Monthly usage limit reached"
# "Rate limit exceeded"
```

## Stall Detection & Recovery

### Manual Monitoring

```bash
# Check for stalled jobs (no output growth for 10min)
until [ $(stat -c%s <logfile> 2>/dev/null || stat -f%z <logfile>) -eq $(stat -c%s <logfile> 2>/dev/null || stat -f%z <logfile>) ]; do
  sleep 300  # Wait 5min
done
echo "Job stalled or completed"
```

### Automatic Monitoring (Optional)

Use the stall-watcher script from `/home/nahar/scripts/stall-watch.sh`:

```bash
# Monitor a job in background
scripts/stall-watch.sh <logfile> <pid> 600 1800 "ticket-name" &
```

Parameters: logfile, pid, stall_timeout_sec (10min default), hard_cap_sec (30min default), label

### Recovery Procedure

1. Detect stall: No output growth for 10 minutes
2. Kill job: `ai-cli kill <pid>`
3. Analyze: Check logs for "limit" or "error"
4. Redispatch:
   - If quota error: Switch to free tier or wait for reset
   - If silent stall: Simplify prompt or split into sub-tickets
   - If task runner error: Escalate to stronger model (cheap → balanced → hard)

## Examples

### Example 1: Simple Feature Ticket

```bash
ai-cli run \
  --cwd /home/nahar/Documents/code/house_designer \
  --model oc-opencode/big-pickle \
  --prompt "
## Ticket: Add sort-by-date feature to catalog sidebar

**Scope:** homely/src/ui/catalog-panel.ts

**DoD:**
- Catalog items show in reverse-date order (newest first)
- Unit test in catalog.test.ts asserts sort order
- Verify: \`npm run test -- catalog\` all pass

Start now. Execute and commit when complete.
"
```

### Example 2: Documentation Ticket

```bash
ai-cli run \
  --cwd /home/nahar/Documents/code/house_designer \
  --model oc-opencode/big-pickle \
  --prompt "
## Ticket: Create CAMERA.md architecture document

**Scope:** docs/architecture/CAMERA.md (new file)

**DoD:**
- Document top-camera-follower state machine (see core/top-camera-follower.ts)
- Include state transitions, bounds calculation, contract reference
- Add 2-3 usage examples

Commit: git add docs/architecture/CAMERA.md && git commit -m 'docs: add camera architecture'

Execute and commit when complete.
"
```

### Example 3: Concurrent Cost Comparison

```bash
# Dispatch to 3 tiers with identical prompt
PROMPT="Explain ai-cli-mcp's job model. Return 2 sentences max."
P1=$(ai-cli run --cwd /tmp --model oc-opencode/big-pickle --prompt "$PROMPT" | jq -r .pid)
P2=$(ai-cli run --cwd /tmp --model oc-opencode/mimo-v2.5-free --prompt "$PROMPT" | jq -r .pid)
P3=$(ai-cli run --cwd /tmp --model claude:opus --prompt "$PROMPT" | jq -r .pid)

# Wait for completion
until ! ai-cli ps | jq -r '.[] | select(.status != "completed") | .pid' | grep -q . ; do sleep 2 ; done

# Compare cost/latency
for p in $P1 $P2 $P3 ; do
  MODEL=$(ai-cli result $p | jq -r .model)
  COST=$(ai-cli result $p | jq '.agentOutput.cost // 0')
  TOKENS=$(ai-cli result $p | jq '.agentOutput.tokens.total')
  echo "$MODEL: cost=$COST tokens=$TOKENS"
done
```

## Troubleshooting

### Task Shows "running" Forever

1. Check logs: `tail ~/.local/share/opencode/log/opencode.log | grep <session-id>`
2. Look for "usage limit", "error", "stream error"
3. If stalled: `ai-cli kill <pid>` and redispatch

### Prompt Too Long / Silent Failure

- Free tiers can have prompt caching bugs with very long prompts (30+ KB)
- Workaround: Split ticket into smaller sub-tasks or use stronger model

### "Monthly usage limit reached"

- opencode-go exhausted, wait for reset (~18 days)
- Use free tiers instead (big-pickle, mimo-v2.5-free, nemotron-*, ling-*)
- Or escalate to claude/codex if critical

### Files Not Created / Commits Not Landed

1. Verify worker actually ran: `ai-cli result <pid> | jq '.exitCode'`
2. Check output: `ai-cli result <pid> | jq '.agentOutput.message'`
3. Redispatch with simpler prompt if worker output is empty

---

**Version:** 2026-09-08  
**Track:** AI-CLI (Track AI-CLI T3)  
**Status:** Setup guide for local + container ai-cli-mcp dispatch
