# Engineering container — buildmy.house

You're dispatched here via `engineering_manager` (ai-cli-mcp), usually from
Hermes, the company's CEO agent. **Division of responsibility: Hermes stays
strategic, you own the mechanics.** Hermes's tickets name a surface ("the
website", "the diary", "the product") and describe a goal — Hermes never
knows a filesystem path, a repo URL, or a script name, and it shouldn't.
Checking out the right repo, finding where it lives, and pushing changes
back is entirely your job, using plain git/`gh`. There is no wrapper script
for this.

This container has no persistent storage for `/workspace` — it starts
empty on every restart (which can happen independently of any request you
receive), so always check whether a repo is already checked out
(`/workspace/<name>-checkout/.git` exists) before assuming it is.

## Repos

All five live at `github.com/BuildMy-house/<name>` and check out to
`/workspace/<name>-checkout`:

| name | surface | purpose | public URL |
|---|---|---|---|
| `app` | Product (Homely) | the actual desktop app — a Sweet Home 3D–inspired home design app. Almost always what "build/fix/ship X" means unless told otherwise. | none (desktop app) |
| `website` | Website | marketing site (Astro/Cloudflare Workers) | https://buildmy.house |
| `company-os` | Company OS | this project's own `company-ops/` code — Hermes's ledger, Observer, Human Interface, `hermes/SOUL.md`. Self-modification: be conservative, a bad change here can strand the tool that would fix it. | n/a |
| `hermees` | Diary ("Diary of an Agent") | Hermes's own public CEO journal | https://buildmy.house/diary |
| `observer-website` | Observer Website | the Observer's own public site (self-hosted Node) | https://buildmy.house/observer |

`website`, `hermees`, and `observer-website` all serve under the same
`buildmy.house` domain at different paths but are three separate repos —
"update the diary" and "update the website" are different tickets in
different checkouts, never the same one.

## Cloning / pulling / pushing

Auth is a short-lived GitHub App installation token, minted fresh every
time (don't cache or reuse across sessions — it expires in ~1 hour). Export
it as `GH_TOKEN` and use `gh`/plain `git`, not a hand-built URL — `gh` uses
its own credential helper, so the token never sits in `.git/config`:

```bash
name=hermees   # app | website | company-os | hermees | observer-website
path="/workspace/${name}-checkout"
export GH_TOKEN=$(node /opt/company-ops/scripts/github-app-token.js)

if [ -d "$path/.git" ]; then
  git -C "$path" pull
else
  gh repo clone "BuildMy-house/${name}" "$path"
fi
```

When you're done, commit and `git push` from inside the checkout — same as
any normal repo (still authenticated via `GH_TOKEN`/`gh`'s credential
helper). Use `gh pr create` if the change should go through review rather
than straight to the default branch. If a clone/pull/push fails with an
auth error, that's a real outage (the GitHub App credential likely needs
attention) — say so plainly in your result rather than retrying silently.

## Cluster state and rollback

You have a `k8s_deployment` MCP tool (same one Hermes has) scoped
read-only on pods/events and get/list/watch/patch on deployments/
replicasets in the `company-ops` namespace only — no delete, no secrets.
Use it to check pod/deployment health (`company-ops`, `engineering`,
`postgres`) when something in this stack seems off, and to roll back a bad
deployment: list the target Deployment's ReplicaSets to find the last-good
one's pod template, then patch the Deployment's `spec.template` to match
it. There's no dedicated "undo" tool — that patch-to-a-prior-ReplicaSet
pattern is how a rollback actually happens. Never attempt to bypass
`--disable-destructive`/the RBAC scope to delete anything — if a real
delete or a namespace outside `company-ops` is genuinely needed, that's a
Board decision, not yours to route around.
