# Product analytics, activation KPIs and feedback

Self-hosted in the app server — no third party, no cost. Data lives in the
app database (`analytics_events`, `feedback` tables; SQLite volume
`buildmyhouse-app-data` in production, Postgres if `DATABASE_URL` is set).

## What is collected

Client: `src/analytics/analytics.ts`. Two random ids, nothing derived from the
user: `sid` (per browsing session, sessionStorage) and `aid` (anonymous device,
localStorage, used only for D1/D7 retention). No IP / user agent / email /
account id is stored. Do Not Track and Global Privacy Control disable it.

Events (server whitelist in `server/src/analytics.ts`): `pageview`,
`session_start`, `first_plan_created`, `first_furniture_placed`,
`first_3d_view_opened`, `split_view_used`, `plan_saved` (account save),
`plan_exported` (`kind`: `png_plan` | `png_3d` | `luxcore` | `print`),
`signup_modal_opened`, `signup_completed`, `login_completed`. `first_*` and
`split_view_used` fire at most once per session.

Definitions: the default layout is split, so the 3D view is on screen from the
start; `first_3d_view_opened` therefore means the user explicitly switched to
3D/split or interacted with the 3D canvas. `first_plan_created` = first wall or
room in the session. A session is *activated* ("furnished 3D view") when it has
both `first_furniture_placed` and `first_3d_view_opened`.

## Feedback widget

`src/ui/feedback-widget.ts` — "Feedback" button bottom-right; text + optional
email; `POST /api/analytics/feedback` with `sid` and plan counts
(`walls/furniture/rooms/levels`). No login. Rate limited per session and
globally.

## Querying KPIs

`GET /api/analytics/kpis?days=14` (1–90) with
`Authorization: Bearer <token>`. Token = `ANALYTICS_ADMIN_TOKEN` env var on the
app container, falling back to `BUILDMYHOUSE_MCP_BEARER_TOKEN` (already in the
container env-file). Returns daily active users, activation
(`activation_rate_furnished_3d`, `rate_3d_view_opened`,
`time_to_first_3d_view_ms`), `retention.d1/d7`, `top_events`,
`exports_by_kind`, `recent_feedback` (newest 50, includes optional emails —
treat as private).

```bash
curl -s -H "Authorization: Bearer $TOKEN" 'https://app.buildmy.house/api/analytics/kpis?days=14'
```
