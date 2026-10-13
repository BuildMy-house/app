# PM-agent chat (widget + proxy)

Widget: `src/ui/chat-widget.ts` (flag `VITE_ENABLE_PM_AGENT_CHAT=true`).
Proxy: `server/src/chat.ts`, mounted in `server/src/app.ts`. Both routes
require the session JWT; the user id sent to pm-agent is always `req.userId`,
never anything from the client. Target: `PM_AGENT_URL`
(+ `PM_AGENT_AUTH_TOKEN` bearer); unset or unreachable => 503.

pm-agent answers **one user at a time**; other users are queued (in memory,
FIFO, max 5 waiting) instead of holding an HTTP request open.

## Endpoints

`POST /api/chat` body `{ message }` ->
- `{ reply }` agent was idle (or queue full: a polite "very busy" reply),
- `{ status: "queued", ticket, position, reply }` busy; `position` is the
  1-based place, `reply` a ready-made plain-text notice,
- `{ status: "processing", ticket, reply? }` your earlier message is still being
  answered or the inline wait ran out; poll the ticket.

`GET /api/chat/status?ticket=<id>` ->
`{ status: "queued", position }` | `{ status: "processing" }` |
`{ status: "done", reply }` | `{ status: "expired" }`. Unknown tickets and
tickets owned by someone else both read `expired` (pm-agent checks the owner).
Queued tickets expire after 5 min, or 90 s without polling; results are kept
120 s.

## Widget behaviour

While queued the widget shows "You're number N in the queue" / "You're next"
and polls every 3 s (`QUEUE_POLL_INTERVAL_MS`); the typing indicator appears
only once the message is processing. Closing the panel stops polling (the
server then drops the abandoned ticket). Sending is blocked while a message is
queued.
