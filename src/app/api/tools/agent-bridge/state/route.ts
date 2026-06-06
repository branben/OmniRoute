/**
 * GET /api/tools/agent-bridge/state
 * Returns the full AgentBridgePageData shape consumed by the dashboard page.
 * Aggregates: MITM server status, DB-backed agent states, bypass patterns,
 * model mappings, cert trust status, and upstream CA path.
 * LOCAL_ONLY: registered in routeGuard.ts
 */
import { getMitmStatus, getAllAgentsStatus } from "@/mitm/manager";
import { checkCertInstalled } from "@/mitm/cert/install";
import { resolveMitmDataDir } from "@/mitm/dataDir";
import { getAllAgentBridgeStates } from "@/lib/db/agentBridgeState";
import { getUserBypassPatterns } from "@/lib/db/agentBridgeBypass";
import { getMappingsForAgent } from "@/lib/db/agentBridgeMappings";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { createErrorResponse } from "@/lib/api/errorResponse";
import path from "path";
import fs from "fs";

const CA_PATH_FILE = path.join(resolveMitmDataDir(), "mitm", "upstream-ca.path");

function readStoredCaPath(): string | null {
  try {
    if (!fs.existsSync(CA_PATH_FILE)) return null;
    const raw = fs.readFileSync(CA_PATH_FILE, "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  try {
    // Fetch MITM status and cert trust in parallel
    const [mitmStatus, certTrusted] = await Promise.all([
      getMitmStatus(),
      (async () => {
        try {
          const certPath = path.join(resolveMitmDataDir(), "mitm", "server.crt");
          return await checkCertInstalled(certPath);
        } catch {
          return false;
        }
      })(),
    ]);

    // Fetch DB-backed datasets in parallel
    const [agentStates, bypassPatterns, allAgents] = await Promise.all([
      getAllAgentBridgeStates(),
      getUserBypassPatterns(),
      getAllAgentsStatus(),
    ]);

    // Build mappings map from DB, keyed by agent_id
    const mappings: Record<string, Array<{ source: string; target: string }>> = {};
    for (const agent of allAgents) {
      try {
        const rows = getMappingsForAgent(agent.id);
        if (rows.length > 0) {
          mappings[agent.id] = rows.map((r) => ({
            source: r.source_model,
            target: r.target_model,
          }));
        }
      } catch {
        // Agent may have no mappings — skip
      }
    }

    // Resolve upstream CA: env var wins over stored file
    const upstreamCa =
      process.env.AGENTBRIDGE_UPSTREAM_CA_CERT || readStoredCaPath() || null;

    const serverState = {
      running: mitmStatus.running,
      port: 443,
      certTrusted,
      upstreamCa,
      lastStartedAt: mitmStatus.lastStartedAt ?? null,
      activeConns: 0,
      interceptedCount: 0,
    };

    return Response.json({
      serverState,
      agentStates,
      bypassPatterns,
      mappings,
    });
  } catch (err) {
    const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return createErrorResponse({ status: 500, message: msg });
  }
}
