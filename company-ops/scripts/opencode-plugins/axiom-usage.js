// Ships compact token-usage and tool-call metrics to Axiom (dataset bmh-company)
// — the cross-tool usage dashboard alongside Hermes and Claude Code. Content-light
// by design: model/provider/tokens/cost and tool names only, no prompts/args/output.
// Registered globally (all opencode invocations in this container, not per-repo) via
// generate-agent-mcp-config.js, which writes this path into opencode.json's `plugin`
// array. Every hook body is failsafe — a broken network call must never interrupt
// an actual coding session.
export const AxiomUsage = async () => {
  const token = process.env.AXIOM_TOKEN;
  if (!token) return {};

  const dataset = process.env.AXIOM_DATASET || "bmh-company";
  // api.axiom.co routes to the default (us-east-1) region; this org's
  // dataset lives in eu-central-1 and ingest requires that region's edge
  // domain + its /v1/ingest/<dataset> path (confirmed live via GET
  // /v1/datasets/bmh-company -> edgeDeploymentUrl).
  const endpoint = `https://eu-central-1.aws.edge.axiom.co/v1/ingest/${dataset}`;
  const queue = [];
  // Track the in-flight flush as a promise (not just a boolean) so dispose()
  // can genuinely await it — confirmed live this is required: `opencode run`
  // is a short-lived one-shot process that tears down right after its task
  // finishes, and a boolean-gated flush left dispose() calling flush() again
  // while the original was still in flight, which just no-opped (busy flag
  // still set) and returned immediately — the fetch never got to complete
  // before the process exited. Zero events reached Axiom until fixed.
  let inFlight = null;

  function flush() {
    if (queue.length === 0) return inFlight || Promise.resolve();
    if (inFlight) return inFlight;
    const batch = queue.splice(0, queue.length);
    inFlight = (async () => {
      try {
        await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(batch),
        });
      } catch {
        // fail-open: usage tracking must never break a coding session
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function push(event) {
    try {
      queue.push({ _time: new Date().toISOString(), service: "opencode", ...event });
      flush();
    } catch {
      // fail-open
    }
  }

  return {
    dispose: async () => {
      await flush();
    },
    event: async ({ event }) => {
      try {
        if (event.type !== "message.updated") return;
        const info = event.properties?.info;
        if (!info || info.role !== "assistant" || !info.time?.completed) return;
        push({
          event: "llm_call",
          sessionID: info.sessionID,
          messageID: info.id,
          model: info.modelID,
          provider: info.providerID,
          tokens: info.tokens,
          cost: info.cost,
        });
      } catch {
        // fail-open
      }
    },
    "tool.execute.after": async (input) => {
      try {
        push({ event: "tool_call", sessionID: input.sessionID, callID: input.callID, tool: input.tool });
      } catch {
        // fail-open
      }
    },
  };
};

// opencode's loader resolves a bare file-path entry in `plugin: [...]` via
// the module's default export (confirmed against @opencode-ai/plugin's own
// example-workspace.js, which exports both named and default) — a named
// export alone is silently never invoked, no error, nothing in the logs.
export default AxiomUsage;
