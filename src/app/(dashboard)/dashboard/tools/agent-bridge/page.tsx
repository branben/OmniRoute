import { getProviderConnections } from "@/lib/db/providers";
import { ALL_TARGETS } from "@/mitm/targets/index";
import {
  AgentBridgePageDataSchema,
  getDefaultAgentBridgePageData,
} from "@/shared/schemas/agentBridge";
import AgentBridgePageClient from "./AgentBridgePageClient";
import type { AgentBridgePageData } from "@/shared/schemas/agentBridge";

/**
 * AgentBridge page — Server Component entry point.
 * Fetches initial state from the backend API and passes to client orchestrator.
 */
export default async function AgentBridgePage() {
  // Check if any providers are configured (D15)
  let hasProviders = false;
  try {
    const connections = await getProviderConnections();
    hasProviders = Array.isArray(connections) && connections.length > 0;
  } catch {
    // If DB not ready yet, show empty state gracefully
    hasProviders = false;
  }

  // Fetch initial AgentBridge state from the REST API
  // Falls back to a safe default if the API isn't ready yet
  let initialData = getDefaultAgentBridgePageData();

  try {
    const base =
      process.env.OMNIROUTE_BASE_URL ??
      `http://127.0.0.1:${process.env.PORT ?? 20128}`;
    const res = await fetch(`${base}/api/tools/agent-bridge/state`, {
      cache: "no-store",
      headers: { "x-internal-fetch": "1" },
    });
    if (res.ok) {
      const json = await res.json();
      const parsed = AgentBridgePageDataSchema.safeParse(json);
      if (parsed.success) {
        initialData = parsed.data;
      } else {
        console.error(
          "[AgentBridgePage] SSR: /state response failed schema validation",
          parsed.error.flatten()
        );
      }
    }
  } catch {
    // Backend not yet available — use defaults; client will poll
  }

  return (
    <AgentBridgePageClient
      initialData={initialData}
      targets={ALL_TARGETS.map(({ handler, ...rest }) => rest)}
      hasProviders={hasProviders}
    />
  );
}
