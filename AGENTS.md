## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## E2E tests (Playwright)

UI and 3D viewport changes MUST be verified with Playwright E2E tests.

### Commands

```bash
cd homely
npm run e2e              # run all E2E tests headless
npm run e2e:open         # open Playwright inspector for debugging
npx playwright test --ui # interactive test runner
```

### When to run

- **Any UI change** (toolbar, menus, status bar, properties panel, layout, CSS)
- **Any 3D viewport change** (camera, scene building, rendering, controls)
- **Any plan-view change** (canvas rendering, input handling, tools)
- Before committing changes to `homely/src/main.ts`, `homely/src/view3d/`, `homely/src/plan/`, `homely/src/ui/`, or `homely/src/style.css`

### Test files

| File | Covers |
|------|--------|
| `e2e/layout.spec.ts` | DOM shell, toolbar, menus, status bar, camera toggles |
| `e2e/viewport3d.spec.ts` | WebGL canvas, 3D rendering, panel visibility, screenshot baseline |
| `e2e/plan-3d-sync.spec.ts` | Cross-view sync, undo/redo, wall drawing flow |

### Writing new E2E tests

- Use `page.waitForSelector('#view3d canvas')` in `beforeEach` to ensure Three.js has booted.
- Interact with the plan via `page.mouse.click()` on `#plan-canvas` coordinates.
- Tool switching: `page.locator('button[data-tool="wall"]').click()`
- Camera presets: `page.locator('button[data-preset="3d"]').click()`
- Check WebGL content via `page.evaluate()` reading pixels from the canvas.
- Screenshot comparisons: `await expect(locator).toHaveScreenshot('name.png')`.

### Debugging failures

- `npx playwright show-trace results/.../trace.zip` to replay a failed run.
- Screenshots saved to `test-results/` on failure.
- HTML report at `playwright-report/` after any run.

## CI

Automated verification runs on every push/PR via `.github/workflows/ci.yml`
(two jobs: `homely` = lint + tsc + vitest + Playwright e2e; `equivalence` =
pytest). The workflow uses whatever lint/test config exists at merge time —
it does not own the config itself.

**No GitHub remote is configured yet**, so Actions cannot run in this
environment. The **authoritative** verification gate is the local script:

```bash
./scripts/verify-all.sh             # all checks (lint+tsc+vitest+e2e+pytest)
./scripts/verify-all.sh --skip-e2e  # fast path, skips slow Playwright suite
```

The script runs every check CI would run, prints a PASS/FAIL summary per
step, and exits non-zero if any step fails. Run it before committing — it is
the automated check that prevents a "done" ticket from shipping with broken
stubs (the U3 regression that motivated this CI). Once a GitHub remote is
added, `ci.yml` runs the identical checks automatically on push/PR.

## Delegated manager subagents (agent-manager and similar)

When dispatching a manager-style subagent (e.g. `agent-manager`) for a
multi-phase, multi-step piece of work — whether for `homely/` or for
`company-ops/` — **spawn a fresh instance of that subagent at each
phase/step boundary rather than resuming one instance across the whole
workstream.** A "step" is a phase or a distinct verification pass (e.g. an
end-to-end smoke test); individual tickets within one step still share the
same instance. Lean on the ticket board and any project plan file as the
durable handoff state — a fresh instance reads those plus a short "what's
verified vs. still open" briefing and picks up cleanly, without needing
the prior instance's own accumulated context. See
`.claude/agents/agent-manager.md`'s "How to use this subagent" section
for the full rationale. (Renamed from `opencode-manager` 2026-09-07 — the
subagent dispatches to opencode, Codex, and Antigravity/Gemini workers,
not just OpenCode, so the old name undersold its actual scope.)
