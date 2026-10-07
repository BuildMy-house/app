/**
 * Privacy-respecting product analytics client (self-hosted: POST /api/analytics/*
 * on the app's own server — no third party).
 *
 * Identity is two random ids, never derived from the user or device:
 *  - sid: per browsing session (sessionStorage) — funnel/activation unit.
 *  - aid: anonymous device id (localStorage) — only used for D1/D7 retention.
 * No IP/UA/account data is sent. Honors Do Not Track / Global Privacy Control.
 * Everything is fire-and-forget; analytics can never break the app.
 */

export type AnalyticsEventName =
  | 'pageview'
  | 'session_start'
  | 'first_plan_created'
  | 'first_furniture_placed'
  | 'first_3d_view_opened'
  | 'split_view_used'
  | 'plan_saved'
  | 'plan_exported'
  | 'signup_modal_opened'
  | 'signup_completed'
  | 'login_completed'

type Props = Record<string, string | number | boolean>

const ENDPOINT = '/api/analytics'
const AID_KEY = 'bmh-aid'
const SID_KEY = 'bmh-sid'
const FIRED_KEY = 'bmh-analytics-fired'
const FLUSH_MS = 2000
const MAX_BATCH = 20

interface QueuedEvent { name: AnalyticsEventName; props?: Props; ts: number }

let sid = ''
let aid = ''
let newSession = false
let queue: QueuedEvent[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let fired = new Set<string>()
let disabled = false

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

function storageGet(store: Storage | undefined, key: string): string | null {
  try { return store?.getItem(key) ?? null } catch { return null }
}

function storageSet(store: Storage | undefined, key: string, value: string): void {
  try { store?.setItem(key, value) } catch { /* private mode / quota: stay in-memory */ }
}

function privacyOptOut(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean }
  return nav.doNotTrack === '1' || nav.globalPrivacyControl === true
}

/** Whether the browser is a real page (not SSR/tests without fetch). */
function canRun(): boolean {
  return typeof window !== 'undefined' && typeof fetch === 'function' && typeof crypto?.randomUUID === 'function'
}

/** Start analytics for this page load: ids, session_start (new sessions only), pageview. */
export function initAnalytics(): void {
  if (!canRun() || privacyOptOut()) { disabled = true; return }
  const ls = typeof localStorage === 'undefined' ? undefined : localStorage
  const ss = typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  aid = storageGet(ls, AID_KEY) ?? randomId()
  storageSet(ls, AID_KEY, aid)
  const existing = storageGet(ss, SID_KEY)
  sid = existing ?? randomId()
  newSession = existing === null
  storageSet(ss, SID_KEY, sid)
  try { fired = new Set(JSON.parse(storageGet(ss, FIRED_KEY) ?? '[]') as string[]) } catch { fired = new Set() }

  if (newSession) track('session_start')
  track('pageview', { path: location.pathname })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', () => flush())
}

export function track(name: AnalyticsEventName, props?: Props): void {
  if (disabled || !sid) return
  queue.push({ name, props, ts: Date.now() })
  if (queue.length >= MAX_BATCH) flush()
  else if (!timer) timer = setTimeout(flush, FLUSH_MS)
}

/** Fire an event at most once per browsing session (milestone / "first_*" events). */
export function trackOnce(name: AnalyticsEventName, props?: Props): void {
  if (disabled || !sid || fired.has(name)) return
  fired.add(name)
  storageSet(typeof sessionStorage === 'undefined' ? undefined : sessionStorage, FIRED_KEY, JSON.stringify([...fired]))
  track(name, props)
}

export function flush(): void {
  if (timer) { clearTimeout(timer); timer = null }
  if (disabled || queue.length === 0) return
  const events = queue.splice(0, MAX_BATCH)
  void post('/events', { sid, aid, events })
  if (queue.length > 0) flush()
}

function post(path: string, body: unknown): Promise<Response | void> {
  return fetch(ENDPOINT + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => undefined)
}

/** Submit in-app feedback. Resolves true when the server stored it. */
export async function submitFeedback(message: string, email: string, state: Props): Promise<boolean> {
  if (!canRun()) return false
  if (!sid) { sid = randomId() } // feedback must work even with analytics opted out
  try {
    const res = await fetch(`${ENDPOINT}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid, message, email: email || undefined, state }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Test seam: reset module state. */
export function _resetAnalyticsForTests(): void {
  sid = ''; aid = ''; newSession = false; queue = []; fired = new Set(); disabled = false
  if (timer) { clearTimeout(timer); timer = null }
}
