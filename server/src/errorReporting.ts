/**
 * Server-side Axiom error reporting. Mirrors the frontend telemetry transport
 * (src/telemetry/transport.ts): plain fetch POST to the ingest API, Bearer
 * token, fire-and-forget, silently dropped on failure. No SDK dependency.
 */

// No hardcoded fallback: Axiom datasets can be pinned to a specific regional
// edge domain, so a guessed default silently breaks ingest. Endpoint/dataset
// must come from Infisical/.env (AXIOM_ENDPOINT, AXIOM_DATASET).
const endpoint = () => process.env.AXIOM_ENDPOINT ?? '';
const dataset = () => process.env.AXIOM_DATASET ?? 'buildmy-house-telemetry';

/**
 * Report an error to Axiom in the background. Never throws, never blocks the
 * caller, and is a complete no-op (no fetch at all) when AXIOM_TOKEN or
 * AXIOM_ENDPOINT is unset.
 * MUST NOT be awaited before responding to the actual client.
 */
export function reportError(err: unknown, context: Record<string, unknown> = {}): void {
  const token = process.env.AXIOM_TOKEN;
  if (!token) return;
  const axiomEndpoint = endpoint();
  if (!axiomEndpoint) return;

  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const event = { _time: new Date().toISOString(), level: 'error', message, stack, ...context };

  // fire-and-forget: transport failures are silently dropped.
  fetch(`${axiomEndpoint}/v1/ingest/${dataset()}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([event]),
  }).catch(() => {
    // Silently drop — error reporting must never break the app.
  });
}
