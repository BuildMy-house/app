# OpenCode delegation cost log

Running log of every OpenCode-delegated task run against this repo: which
model/tier it used, what it cost, and what happened. Append a row every
time a task is dispatched via the agent-manager's OpenCode dispatch (see
`.claude/agents/agent-manager.md` for the dispatch/verification discipline
this log supports).

## What cost data Claude actually has — be honest about this

Claude has **real per-token pricing for Anthropic's own Claude models**
(e.g. Claude Opus 5: $5/$25 per 1M input/output tokens; Claude Sonnet 5:
$3/$15; Claude Haiku 4.5: $1/$5) — current as of early 2025, re-verifiable
via the `claude-api` skill or the Anthropic pricing page if ever in doubt.

Claude does **not** have equivalent real $/token pricing for the third-party
models reachable through OpenCode (mimo-v2.5, glm-5.3, deepseek-v4-flash,
kimi-k2.7-code, etc.). `opencode_list_agents` only exposes a `per_5h`
request-count estimate and a `tier` label (high-volume/balanced/scarce)
against one shared dollar pool — that is a *relative* signal (fewer
requests/5h implies a pricier model), not an actual price. Treat "scarce
tier" as shorthand for "expensive, use sparingly," not as a number to do
arithmetic with. Don't state or imply a precise dollar figure for a
non-Anthropic model — say "scarce tier" / "per the quota snapshot," not a
fabricated $/token.

## What the columns mean

- **Provider/model**: exact `providerID/modelID` used, copied verbatim from
  `opencode` CLI output — never a guessed id.
- **Tier**: `free` (OpenCode Zen, e.g. `opencode/mimo-v2.5-free` — $0, no
  shared budget), `high-volume`/`balanced`/`scarce` (`opencode-go`, draws
  from a shared monthly pool — check quota status with `opencode models`),
  or `unlisted` (quota `null` — treat as scarce until proven otherwise).
- **Cost ($)**: dollar cost reported by the OpenCode session. `0` on the
  free tier is real — it is not billed. On `opencode-go`, a non-zero value
  draws down the shared budget.
- **Tokens (in/out/cache-read)**: from the session's token fields. Cache-read
  tokens are typically far larger than input/output on a long session (the
  whole prior conversation gets re-sent as cached context each turn) — high
  cache-read is normal and not a cost signal on the free tier, but is a
  *time* signal: a session with a huge cache-read total has accumulated a
  lot of context and is more likely to hit stall/timeout failure modes.
- **Outcome**: `done` / `stalled→resumed` / `usage-limit wall` / `cancelled`.

## Why this is tracked — cost optimization is paramount

**Default to the free tier** (`opencode/mimo-v2.5-free` or similar) for any
ticket that a cheap model can plausibly do correctly — UI component work
following an established pattern, core algorithm implementation (like
WallLoopDetector), testing/verification work, docs, mechanical refactors.
This is the default, not one option among equals — reach for a paid tier
only when the free tier has actually proven inadequate for the specific
ticket, not preemptively "just in case" it does better.

**Use expensive (scarce-tier) models very sparingly** — reserve them for
tickets that are genuinely hard, ambiguous, or high-blast-radius (cross-cutting
design decisions, novel algorithms, security-critical logic) where a wrong
answer is costly to unwind. Even then, prefer the cheapest tier that still
plausibly fits before reaching for `scarce`; a `balanced`-tier model that
gets it right on the first try beats a `scarce`-tier one used out of
caution. See the tier-matching guidance in `.claude/agents/agent-manager.md`.

Log every dispatch here so it's visible, over time, whether that discipline
is actually being followed — if this log fills up with paid-tier rows for
work the free tier could have handled, that's a signal to recalibrate, not
a sunk cost to ignore.

The shared `opencode-go` budget can be exhausted for multi-day windows by
heavy use in a single session, so treat it as a finite resource to spend
deliberately, not a default.

## Log

| Date | Ticket / phase | Provider/model | Tier | Cost ($) | Tokens (in/out/cache-read) | Outcome | Notes |
|------|-----------------|-----------------|------|----------|----------------------------|---------|-------|
| — | — | — | — | — | — | — | *(Start logging here: append a row for every dispatch)* |

## Running totals

- **This session:** $0.00 (start of tracking — no dispatches yet)
- **Project lifetime:** $0.00
