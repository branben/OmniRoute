import { z } from "zod";

export const AgentBridgeStateRowSchema = z.object({
  agent_id: z.string(),
  dns_enabled: z.boolean(),
  cert_trusted: z.boolean(),
  setup_completed: z.boolean(),
  last_started_at: z.string().datetime().nullable(),
  last_error: z.string().nullable(),
});

export const AgentBridgeMappingRowSchema = z.object({
  agent_id: z.string(),
  source_model: z.string(),
  target_model: z.string(),
  updated_at: z.string().datetime(),
});

export const AgentBridgeBypassRowSchema = z.object({
  pattern: z.string(),
  source: z.enum(["default", "user"]),
  created_at: z.string().datetime(),
});

export const AgentBridgeServerActionSchema = z.object({
  action: z.enum(["start", "stop", "restart", "trust-cert", "regenerate-cert"]),
});

export const AgentBridgeDnsActionSchema = z.object({ enabled: z.boolean() });

export const AgentBridgeMappingPutSchema = z.object({
  mappings: z.array(z.object({ source: z.string(), target: z.string() })),
});

export const AgentBridgeBypassUpsertSchema = z.object({ patterns: z.array(z.string()) });

export const AgentBridgeUpstreamCaPostSchema = z.object({ path: z.string().min(1) });

// ── Page Data Schema (camelCase, deep validation) ─────────────────────────────
// This schema validates the full AgentBridgePageData shape returned by /state.
// Uses camelCase for API/client response; DB row schemas remain snake_case.

const AgentStateEntrySchema = z.object({
  agent_id: z.string(),
  dns_enabled: z.boolean(),
  cert_trusted: z.boolean(),
  setup_completed: z.boolean(),
  last_started_at: z.string().datetime().nullable(),
  last_error: z.string().nullable(),
});

const AgentBridgeServerStateSchema = z.object({
  running: z.boolean(),
  port: z.number().int().positive(),
  certTrusted: z.boolean(),
  upstreamCa: z.string().nullable(),
  lastStartedAt: z.string().datetime().nullable(),
  activeConns: z.number().int().min(0),
  interceptedCount: z.number().int().min(0),
});

const MappingRowSchema = z.object({
  source: z.string(),
  target: z.string(),
});

const AgentMappingsMapSchema = z.record(z.array(MappingRowSchema));

export const AgentBridgePageDataSchema = z.object({
  serverState: AgentBridgeServerStateSchema,
  agentStates: z.array(AgentStateEntrySchema),
  bypassPatterns: z.array(z.string()),
  mappings: AgentMappingsMapSchema,
});

export type AgentBridgePageData = z.infer<typeof AgentBridgePageDataSchema>;

/**
 * Default factory for AgentBridgePageData.
 * Used by SSR and client for safe fallback when API returns invalid data.
 */
export function getDefaultAgentBridgePageData(): AgentBridgePageData {
  return {
    serverState: {
      running: false,
      port: 443,
      certTrusted: false,
      upstreamCa: null,
      lastStartedAt: null,
      activeConns: 0,
      interceptedCount: 0,
    },
    agentStates: [],
    bypassPatterns: [],
    mappings: {},
  };
}
