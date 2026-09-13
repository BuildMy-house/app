# Infisical Secrets & Account-Based Auth Setup

Tracks the current state of secret management in Infisical for house_designer/BuildMy.house,
how to finish setting it up, and the runbook for Claude/Codex account auth (subscription-based,
not API keys) for the engineering container. Last updated 2026-09-13.

This supersedes the earlier `company-ops/INFISICAL_SETUP.md` draft, which proposed **two**
separate Infisical projects (`buildmy-house-ops` / `buildmy-house-infra`). What actually got
built is a hybrid: **one** project (`Build My house`) with two folders for company-ops/engineering
tooling access control, plus a **second, fully separate** project (`buildmyhouse-app`, added
2026-09-13) for the deployed product's own runtime secrets — deliberately not a third folder in
the first project, since `/hermes`/`/infra` exist to scope *container* access and the deployed
app server is not a company-ops/engineering container at all. Don't recreate the two-project
layout from the old draft — this file is the current source of truth.

## Infisical projects

- **Build My house** (`build-my-house-yn1q`, id `8806c2b0-73d2-4bea-8537-5b874c5ff592`) —
  company-ops + engineering container tooling secrets. Environments: `dev`, `staging`, `prod`.
- **buildmyhouse-app** (`buildmyhouse-app`, id `58b43b81-effb-4392-a937-46f2448efb78`) — the
  buildmyhouse/Homely **product's own runtime secrets**, read directly by the deployed server
  process (`buildmyhouse/server/`). Fully independent access control from the project above —
  the engineering container's machine identity has no reason to ever read production app
  secrets, and vice versa. Environments: `dev`, `staging`, `prod` (all auto-created, only `dev`
  and `prod` have real secrets in them so far — see below).
- Instance: EU (`INFISICAL_API_URL` in `.env.local` / `company-ops/.env.local`)

## Two-tier folder structure (Build My house project only)

`company-ops/.env.example` documents this split; Infisical mirrors it as folders inside each
environment of the **Build My house** project:

| Folder | Tier | Readable by | Contents |
|---|---|---|---|
| `/hermes` | Tier 1 | CEO / hermes-gateway container (`company-ops` service) | Discord bot config, Postgres app-role passwords, NOUS key |
| `/infra` | Tier 2 | Engineering/app container (`engineering` service) only, **not** hermes | GitHub App creds, R2, Claude/Codex/OpenCode/Z.AI auth, Axiom tokens |

An empty `/app` folder briefly existed under `dev` here (created, then abandoned same day in
favor of the separate `buildmyhouse-app` project below) — it's harmless but unused; delete it via
the dashboard next time someone's in there (no MCP tool here can delete a folder).

## buildmyhouse-app project (product runtime secrets)

No folder structure — secrets live flat at `/` in each environment, since there's no
container-access-tiering concern here (it's one deployed server process reading its own env).

**`dev` and `prod` (created 2026-09-13):** `RESEND_API_KEY` and `RESEND_FROM_EMAIL` exist as
blank placeholders in both — Nahar is filling in real values directly via the Infisical
dashboard, not through this MCP tooling. Without them the server falls back to logging email
content to its own console (`[email:dev-fallback]` — see `buildmyhouse/server/src/email.ts`), so
nothing is broken by these being blank, but no real email goes out until they're set. `staging`
has no secrets yet.

**Not yet migrated here, still plain docker-compose/`.env` values today:** `JWT_SECRET`,
`DATABASE_URL`, `APP_BASE_URL`. Worth moving into this project too at some point for the same
reason Resend's keys are here (single source of truth, no secret sitting in a shell history or
a `.env` file on a deploy box) — not done yet, nobody's asked for it, flagging it as a natural
next step rather than doing it unprompted.

`entrypoint.sh` and `engineering-entrypoint.sh` both already call `infisical export --token
"$INFISICAL_TOKEN"` — the tier separation is enforced by scoping each container's
`INFISICAL_TOKEN` (machine identity) to only its own folder path, not by a `--path` flag in
the script.

## Remaining setup: scope a machine identity per container

Not yet done — the MCP tools available here (`create-project`, `create-folder`,
`create-secret`, …) don't cover Infisical identity/access-policy management, so this one-time
step has to happen in the Infisical dashboard directly:

1. **Project Settings → Machine Identities → Add Identity**, create `hermes-gateway` (per
   environment, e.g. `-dev`/`-prod` suffix if you want separate creds per env).
2. Grant it a project role scoped to `secretPath` `/hermes`, **read-only**, in the relevant
   environment(s). No access to `/infra`.
3. Generate an **Access Token** (or Universal Auth client id/secret) for it — this becomes
   the `company-ops` (hermes) container's `INFISICAL_TOKEN`.
4. Repeat for `engineering-manager`, scoped to `secretPath` `/infra` only, read-only. This
   becomes the `engineering` container's `INFISICAL_TOKEN`.
5. Set each token at container start: `INFISICAL_TOKEN=<hermes-token> docker compose up
   company-ops` / `INFISICAL_TOKEN=<engineering-token> docker compose up engineering` (or
   wire into whatever secret store starts the containers in CI/prod — never bake into
   `docker-compose.yml` directly).

**Verify after setup:**
```bash
docker compose exec company-ops bash -c 'echo $DISCORD_BOT_TOKEN'   # should resolve
docker compose exec company-ops bash -c 'echo $GITHUB_APP_PRIVATE_KEY'  # should be EMPTY — hermes has no /infra access
docker compose exec engineering bash -c 'echo $GITHUB_APP_PRIVATE_KEY'  # should resolve
```

**Troubleshooting:**
- Container starts but nothing injected → check `INFISICAL_TOKEN` is actually set in the
  container (`echo $INFISICAL_TOKEN`), and check `docker compose logs <service> | grep
  infisical` for `[infisical] ERROR: Failed to fetch secrets`.
- Wrong secrets missing → the token's role is probably scoped to the wrong `secretPath`, or
  to the wrong environment (`dev` vs `staging` vs `prod`).

## Current state (`dev` environment)

**`/hermes`:**
- `POSTGRES_PASSWORD` (root)
- `COMPANY_PASSWORD`, `OBSERVER_PASSWORD`, `ANALYTICS_PASSWORD` — freshly generated
  2026-09-13 (`secrets.token_urlsafe(20)`, matching the convention the original setup draft
  used). **Caution:** these only work once the Postgres roles (`hermes_company`,
  `hermes_observer_writer`, `hermes_analytics` — see `company-ops/sql/roles.sql` and
  `scripts/04-set-role-passwords.sh`) are (re)created against these values. If a `dev`
  Postgres volume already exists with old/different role passwords, it needs to be
  reinitialized (or the roles' passwords updated) to pick these up — don't assume an existing
  running Postgres just starts accepting them.

**`/infra`:**
- `AXIOM_TOKEN`, `AXIOM_ORG_ID` — query-scoped Axiom read token (company-ops telemetry-query)
- `VITE_AXIOM_TOKEN` — separate write-only ingest token for the app's own telemetry (do not
  reuse the query token here — see the warning already in `buildmyhouse/.env.example`)
- `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`
- `OPENCODE_GO_API_KEY` — OpenCode Go provider (not OpenCode Zen)
- `ZAI_CODING_PLAN_API_KEY` — Z.AI Coding Plan subscription key for `glm-5.3-flash`
- `TOKENROUTER_API_KEY` — **free tier**, kept and preferred (see below)

The root path (`/`) in `dev` was cleared once these were migrated into their folders — no
secret should exist both flat and in a folder.

`staging` and `prod` folders/secrets have **not** been created yet — only `dev` has real
values right now.

**Decisions from 2026-09-13:** this project uses OpenCode **Go**, not OpenCode Zen —
`OPENCODE_ZEN_API_KEY` is gone, replaced by `OPENCODE_GO_API_KEY`. Slack backup notifications
are not used — `SLACK_WEBHOOK_URL` removed entirely. **TokenRouter is kept — it's a confirmed
free-tier provider (`tokenrouter/z-ai/glm-5.3-free`) and should be exploited as heavily as
possible by the engineering container before reaching for any paid/quota-limited provider**
(`opencode-go`, `zai-coding-plan`, Anthropic API). `company-ops/scripts/engineering-entrypoint.sh`
now exports `TOKENROUTER_API_KEY`/`OPENCODE_GO_API_KEY`/`ZAI_CODING_PLAN_API_KEY` for ai-cli and
its default `ai-cli` config.toml has a new `[worker.free]` tier on `tokenrouter/z-ai/glm-5.3-free`
set as the `[default]` worker. `company-ops/.env.example` and `company-ops/README.md` were
updated to match; the default `AGENT_MODEL` stayed as `tokenrouter/z-ai/glm-5.3-free`. Also
noted in `AGENTS.md` (read by every OpenCode agent in this repo via `opencode.json`'s
`instructions` list) and in the global `~/.claude/CLAUDE.md` delegated-model catalog, so any
agent choosing a model — not just the engineering container's own ai-cli config — knows to
prefer TokenRouter.

## Still needed (no value available locally — do not fabricate)

From `company-ops/.env.example`, still blank in Infisical:

- `/hermes`: `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USERS`, `DISCORD_ALLOWED_CHANNELS`,
  `DISCORD_ANNOUNCE_CHANNEL`, `DISCORD_HIL_CHANNEL`, `DISCORD_FINANCE_CHANNEL`, `NOUS_API_KEY`
- `/infra`: `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- `/infra`: `CLAUDE_CODE_OAUTH_TOKEN`, and a Codex equivalent — see account auth below
  (deferred)

## Account-based auth for Claude & Codex (deferred — not yet done)

Goal: the engineering container should authenticate as a Claude/ChatGPT **subscription
account**, not pay-per-token API keys. `company-ops/docker-compose.yml`'s `engineering`
service currently still sets `ANTHROPIC_API_KEY` / `CODEX_API_KEY` as plain env vars — these
should be removed once the OAuth-based secrets below are wired in.

Both CLIs support a manual/remote auth flow that doesn't need a browser on the same host
running the CLI — useful for a headless container or a remote box:

- **Claude:** `claude setup-token` prints an OAuth URL. Opening it and authorizing shows a
  short code, which has to be pasted back into the still-running CLI prompt
  (`Paste code here if prompted >`) to finish and print the long-lived token.
- **Codex:** `codex login --device-auth` prints a URL plus a one-time code (expires in 15
  min). The user authorizes in their own browser; the CLI polls and completes on its own —
  nothing needs to be pasted back.

Because both flows block waiting for input/completion, run them in a detached `tmux`
session so they survive across turns of a conversation (a plain backgrounded shell process
doesn't work — these are TTY/ink-rendered UIs and print nothing without a real pty):

```bash
# Claude
tmux new-session -d -s claude-token-setup -x 220 -y 50 "claude setup-token"
tmux capture-pane -t claude-token-setup -p   # read the URL off the pane
# ...user authorizes in their browser, sends back the short code...
tmux send-keys -t claude-token-setup "<code-from-user>" Enter
tmux capture-pane -t claude-token-setup -p   # prints the resulting CLAUDE_CODE_OAUTH_TOKEN

# Codex
tmux new-session -d -s codex-device-auth -x 220 -y 50 "codex login --device-auth"
tmux capture-pane -t codex-device-auth -p    # read URL + one-time code
# ...user authorizes in their browser...
tmux capture-pane -t codex-device-auth -p    # re-check until it shows "Signed in"
```

What to do with the result once this is resumed:
- Claude: store the printed token as `CLAUDE_CODE_OAUTH_TOKEN` in Infisical under `/infra`.
  The engineering container's `ai-cli` config should use this instead of
  `ANTHROPIC_API_KEY` for its `hard` (Claude Opus) worker.
- Codex: a completed `codex login --device-auth` writes ChatGPT OAuth tokens to
  `~/.codex/auth.json` locally. For the container, store that file's JSON contents as one
  secret (e.g. `CODEX_AUTH_JSON`) under `/infra`, and have
  `company-ops/scripts/engineering-entrypoint.sh` write it out to
  `$CODEX_HOME/auth.json` (default `/root/.codex/auth.json`) at container start — the same
  pattern already used there for `GITHUB_APP_PRIVATE_KEY`.
- Once both are wired in, delete `ANTHROPIC_API_KEY` / `CODEX_API_KEY` from
  `company-ops/docker-compose.yml`'s `engineering` service and from `.env.example`.

**Status:** started 2026-09-13, then paused at the user's request before any code/token was
exchanged — no `CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_AUTH_JSON` exists yet. Resume by following
the steps above.

## Known issues — flagged, not fixed (per user, 2026-09-13)

- `.codex/config.json` (repo root, **tracked in git**) and `CODEX_STEWARD_SETUP.md` both
  contain a live Steward ACS bearer token (`acs_dev_6062…`) in plaintext, committed in
  `fb5fef1`. Deferred by the user for now. Revisit before the repo goes any more public, or
  during a broader secrets-hygiene pass — rotating the token and untracking the file is safe
  on a shared/concurrent repo; scrubbing git history is the disruptive part and needs
  coordination with any other active sessions first.
- Repo-root `opencode.json` (**not tracked in git**, local-only) also has a live Steward
  bearer token (`acs_dev_8b58…`, different token from the one above) and an Axiom token
  (`xaat-fb3f3f66…`) embedded in plaintext. Lower urgency since it's not committed, but worth
  moving to env-var references (`{env:...}`, as the file already does for
  `TOKENROUTER_API_KEY`) rather than inline values.
