// ponytail: in-memory auth event tracking with sliding window spike detection.
// No external telemetry dependency — matches existing codebase pattern (Maps + console.log).
// Upgrade to a real metrics system (Prometheus, StatsD, etc.) if multi-process or
// persistent metrics are ever needed.

interface AuthEvent {
  timestamp: number;
  success: boolean;
  email?: string;
  ip?: string;
  reason?: string;
}

interface SpikeWindow {
  events: AuthEvent[];
}

const loginEvents: SpikeWindow = { events: [] };
const authVerifyEvents: SpikeWindow = { events: [] };

const SPIKE_WINDOW_MS = 5 * 60 * 1000; // 5-minute sliding window
const LOGIN_SPIKE_THRESHOLD = 20;       // failures in window to trigger alert
const AUTH_FAIL_SPIKE_THRESHOLD = 50;   // 401s in window to trigger alert

let spikeCooldown = 0;
const SPIKE_COOLDOWN_MS = 5 * 60 * 1000; // don't re-alert within 5 min

function pruneWindow(window: SpikeWindow): void {
  const cutoff = Date.now() - SPIKE_WINDOW_MS;
  while (window.events.length > 0 && window.events[0]!.timestamp < cutoff) {
    window.events.shift();
  }
}

function checkSpike(window: SpikeWindow, label: string, threshold: number): void {
  pruneWindow(window);
  const now = Date.now();
  const failures = window.events.filter((e) => !e.success).length;
  if (failures >= threshold && now - spikeCooldown > SPIKE_COOLDOWN_MS) {
    spikeCooldown = now;
    console.error(`[auth-telemetry] SPIKE: ${failures} ${label} failures in last ${SPIKE_WINDOW_MS / 1000}s`);
  }
}

export function recordLoginAttempt(success: boolean, email?: string, ip?: string, reason?: string): void {
  loginEvents.events.push({ timestamp: Date.now(), success, email, ip, reason });
  checkSpike(loginEvents, 'login', LOGIN_SPIKE_THRESHOLD);
}

export function recordAuthVerify(success: boolean, ip?: string, reason?: string): void {
  authVerifyEvents.events.push({ timestamp: Date.now(), success, ip, reason });
  checkSpike(authVerifyEvents, 'auth-verify', AUTH_FAIL_SPIKE_THRESHOLD);
}

export function getLoginStats(): { total: number; successes: number; failures: number } {
  pruneWindow(loginEvents);
  const total = loginEvents.events.length;
  const successes = loginEvents.events.filter((e) => e.success).length;
  return { total, successes, failures: total - successes };
}

export function getAuthVerifyStats(): { total: number; successes: number; failures: number } {
  pruneWindow(authVerifyEvents);
  const total = authVerifyEvents.events.length;
  const successes = authVerifyEvents.events.filter((e) => e.success).length;
  return { total, successes, failures: total - successes };
}

// For testing: reset all state
export function _resetTelemetry(): void {
  loginEvents.events.length = 0;
  authVerifyEvents.events.length = 0;
  spikeCooldown = 0;
}
