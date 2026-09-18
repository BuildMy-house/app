# Steward ACS — Agent Instructions (app/)

## Your Repository

`Repo: buildmy-house-app`

This is a separate git checkout (its own `.git`) nested under the
`buildmy.house` workspace root — do NOT use the root's `buildmy.house` repo
name when working here. Confirm with `git rev-parse --show-toplevel` that
you're inside this checkout before your first `lock_file` call, then pass
`repo: "buildmy-house-app"` with `repo_confirmed: true`.

See the workspace root `../AGENTS_STEWARD.md` for the full ACS protocol
(create/claim work, lock files, save learnings, release). It applies here
verbatim — only the `Repo:` value differs.
