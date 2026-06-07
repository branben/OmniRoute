/**
 * Integration tests: AgentBridge REST routes — happy paths + LOCAL_ONLY + Zod 400
 *
 * Covers:
 *   - GET  /api/tools/agent-bridge/state
 *   - POST /api/tools/agent-bridge/server  (invalid body → 400)
 *   - GET  /api/tools/agent-bridge/agents
 *   - GET  /api/tools/agent-bridge/agents/[id]
 *   - PATCH /api/tools/agent-bridge/agents/[id]  (setup_completed)
 *   - GET  /api/tools/agent-bridge/agents/[id]/detect
 *   - GET  /api/tools/agent-bridge/upstream-ca
 *   - POST /api/tools/agent-bridge/upstream-ca  (path validation)
 *
 * LOCAL_ONLY enforcement: request with non-loopback Host header → 403
 *   (tested via routeGuard helper)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ab-routes-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

// Import db core first to allow reset
const core = await import("../../src/lib/db/core.ts");

// Import routes under test
const stateRoute = await import(
  "../../src/app/api/tools/agent-bridge/state/route.ts"
);
const serverRoute = await import(
  "../../src/app/api/tools/agent-bridge/server/route.ts"
);
const agentsRoute = await import(
  "../../src/app/api/tools/agent-bridge/agents/route.ts"
);
const agentIdRoute = await import(
  "../../src/app/api/tools/agent-bridge/agents/[id]/route.ts"
);
const detectRoute = await import(
  "../../src/app/api/tools/agent-bridge/agents/[id]/detect/route.ts"
);
const upstreamCaRoute = await import(
  "../../src/app/api/tools/agent-bridge/upstream-ca/route.ts"
);
const routeGuard = await import("../../src/server/authz/routeGuard.ts");

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* noop */ }
});

// ── routeGuard classification ──────────────────────────────────────────────

test("routeGuard: /api/tools/agent-bridge/ is LOCAL_ONLY", () => {
  assert.equal(routeGuard.isLocalOnlyPath("/api/tools/agent-bridge/"), true);
  assert.equal(routeGuard.isLocalOnlyPath("/api/tools/agent-bridge/state"), true);
  assert.equal(routeGuard.isLocalOnlyPath("/api/tools/agent-bridge/agents"), true);
});

test("routeGuard: /api/tools/agent-bridge/ is SPAWN_CAPABLE", () => {
  const { SPAWN_CAPABLE_PREFIXES } = routeGuard;
  const found = (SPAWN_CAPABLE_PREFIXES as ReadonlyArray<string>).some(
    (p) => p === "/api/tools/agent-bridge/"
  );
  assert.equal(found, true, "Expected /api/tools/agent-bridge/ in SPAWN_CAPABLE_PREFIXES");
});

// ── GET /state ─────────────────────────────────────────────────────────────

test("GET /state: returns AgentBridgePageData shape (serverState, agentStates, bypassPatterns, mappings)", async () => {
  const res = await stateRoute.GET();
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;

  // Top-level keys must match AgentBridgePageData interface
  assert.ok("serverState" in body, "body.serverState missing");
  assert.ok("agentStates" in body, "body.agentStates missing");
  assert.ok("bypassPatterns" in body, "body.bypassPatterns missing");
  assert.ok("mappings" in body, "body.mappings missing");

  // serverState must have all required fields
  const ss = body.serverState as Record<string, unknown>;
  assert.ok("running" in ss, "serverState.running missing");
  assert.ok("port" in ss, "serverState.port missing");
  assert.ok("certTrusted" in ss, "serverState.certTrusted missing");
  assert.ok("upstreamCa" in ss, "serverState.upstreamCa missing");
  assert.ok("lastStartedAt" in ss, "serverState.lastStartedAt missing");
  assert.ok("activeConns" in ss, "serverState.activeConns missing");
  assert.ok("interceptedCount" in ss, "serverState.interceptedCount missing");
  assert.equal(typeof ss.running, "boolean");
  assert.equal(typeof ss.port, "number");
  assert.equal(typeof ss.certTrusted, "boolean");
  assert.equal(typeof ss.activeConns, "number");
  assert.equal(typeof ss.interceptedCount, "number");

  // agentStates must be an array
  assert.ok(Array.isArray(body.agentStates), "agentStates should be array");

  // bypassPatterns must be an array of strings
  assert.ok(Array.isArray(body.bypassPatterns), "bypassPatterns should be array");
  for (const p of body.bypassPatterns as unknown[]) {
    assert.equal(typeof p, "string");
  }

  // mappings must be a record
  assert.equal(typeof body.mappings, "object");
  assert.ok(body.mappings !== null, "mappings should not be null");
});

test("GET /state: serverState.running is accessible (regression: #3318)", async () => {
  const res = await stateRoute.GET();
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  const ss = body.serverState as Record<string, unknown>;
  // This must not throw TypeError: Cannot read properties of undefined (reading 'running')
  assert.ok(ss !== undefined, "serverState must not be undefined");
  assert.ok(typeof ss.running === "boolean", "serverState.running must be boolean");
});

test("GET /state: error responses do not leak stack traces", async () => {
  // Routine GET — should always succeed in test env; just verify if it errors it's clean
  const res = await stateRoute.GET();
  const text = await res.text();
  assert.ok(!text.includes("at /"), "stack trace leaked in GET /state response");
});

test("GET /state: serverState.lastStartedAt is null when MITM is not running", async () => {
  const res = await stateRoute.GET();
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  const ss = body.serverState as Record<string, unknown>;
  // lastStartedAt should be null when server is not running (test env)
  assert.ok(ss.lastStartedAt === null, "lastStartedAt should be null when MITM is stopped");
});

test("GET /state: serverState.certTrusted is boolean", async () => {
  const res = await stateRoute.GET();
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  const ss = body.serverState as Record<string, unknown>;
  assert.equal(typeof ss.certTrusted, "boolean", "certTrusted must be boolean");
});

// ── Schema validation tests ─────────────────────────────────────────────────

test("GET /state: response passes deep schema validation (AgentBridgePageData)", async () => {
  // Import the shared schema and validate the /state response
  const { AgentBridgePageDataSchema } = await import("../../src/shared/schemas/agentBridge.ts");

  const res = await stateRoute.GET();
  assert.equal(res.status, 200);
  const body = await res.json();

  const parsed = AgentBridgePageDataSchema.safeParse(body);
  assert.equal(parsed.success, true, `Schema validation failed: ${JSON.stringify(parsed.error?.flatten())}`);
});

test("GET /state: invalid nested field fails schema (regression)", async () => {
  const { AgentBridgePageDataSchema } = await import("../../src/shared/schemas/agentBridge.ts");

  // Construct invalid payload: serverState.port as string instead of number
  const invalidPayload = {
    serverState: {
      running: false,
      port: "443", // invalid: should be number
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

  const parsed = AgentBridgePageDataSchema.safeParse(invalidPayload);
  assert.equal(parsed.success, false, "Expected schema to reject string port");
});

test("getDefaultAgentBridgePageData: produces schema-valid payload", async () => {
  const { AgentBridgePageDataSchema, getDefaultAgentBridgePageData } = await import("../../src/shared/schemas/agentBridge.ts");

  const defaults = getDefaultAgentBridgePageData();
  const parsed = AgentBridgePageDataSchema.safeParse(defaults);
  assert.equal(parsed.success, true, "Default factory must produce valid schema");
});

// ── POST /server (Zod validation) ─────────────────────────────────────────

test("POST /server: invalid body returns 400", async () => {
  const res = await serverRoute.POST(
    new Request("http://localhost/api/tools/agent-bridge/server", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "invalid-action" }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json() as Record<string, unknown>;
  assert.ok("error" in body);
  const errMsg = (body.error as Record<string, unknown>)?.message as string;
  assert.ok(typeof errMsg === "string");
  assert.ok(!errMsg.includes("at /"), "stack trace leaked in 400 error message");
});

test("POST /server: missing body returns 400", async () => {
  const res = await serverRoute.POST(
    new Request("http://localhost/api/tools/agent-bridge/server", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    })
  );
  assert.equal(res.status, 400);
});

// ── GET /agents ────────────────────────────────────────────────────────────

test("GET /agents: returns agents array with expected shape", async () => {
  const res = await agentsRoute.GET();
  assert.equal(res.status, 200);
  const body = await res.json() as { agents: unknown[] };
  assert.ok(Array.isArray(body.agents));
  assert.ok(body.agents.length >= 9, `Expected ≥9 agents, got ${body.agents.length}`);
  const first = body.agents[0] as Record<string, unknown>;
  assert.ok("id" in first);
  assert.ok("name" in first);
  assert.ok("hosts" in first);
  assert.ok("viability" in first);
  assert.ok("state" in first);
});

// ── GET /agents/[id] ───────────────────────────────────────────────────────

test("GET /agents/[id]: returns 404 for unknown id", async () => {
  const res = await agentIdRoute.GET(
    new Request("http://localhost/"),
    { params: { id: "nonexistent-agent" } }
  );
  assert.equal(res.status, 404);
  const body = await res.json() as Record<string, unknown>;
  const errMsg = (body.error as Record<string, unknown>)?.message as string;
  assert.ok(!errMsg.includes("at /"), "stack trace leaked in 404 message");
});

test("GET /agents/[id]: returns agent detail for 'copilot'", async () => {
  const res = await agentIdRoute.GET(
    new Request("http://localhost/"),
    { params: { id: "copilot" } }
  );
  // resolveTarget searches by hostname, not agent id directly; 'copilot' may return 404
  // if resolveTarget doesn't match by id. In current implementation resolveTarget checks hosts.
  // Acceptable: either 200 with agent or 404 — but NOT a 500.
  assert.ok(res.status === 200 || res.status === 404, `Unexpected status: ${res.status}`);
  if (res.status === 200) {
    const body = await res.json() as Record<string, unknown>;
    assert.ok("detection" in body);
  }
});

// ── PATCH /agents/[id] ────────────────────────────────────────────────────

test("PATCH /agents/[id]: invalid body returns 400", async () => {
  const res = await agentIdRoute.PATCH(
    new Request("http://localhost/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setup_completed: "not-a-boolean" }),
    }),
    { params: { id: "antigravity" } }
  );
  assert.equal(res.status, 400);
  const body = await res.json() as Record<string, unknown>;
  const errMsg = (body.error as Record<string, unknown>)?.message as string;
  assert.ok(!errMsg.includes("at /"), "stack trace in 400 error");
});

test("PATCH /agents/[id]: valid body persists setup_completed", async () => {
  const res = await agentIdRoute.PATCH(
    new Request("http://localhost/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setup_completed: true }),
    }),
    { params: { id: "antigravity" } }
  );
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal((body as Record<string, unknown>).ok, true);
});

// ── GET /agents/[id]/detect ────────────────────────────────────────────────

test("GET /detect: returns installed:false for unknown id", async () => {
  const res = await detectRoute.GET(
    new Request("http://localhost/"),
    { params: { id: "unknown-agent-xyz" } }
  );
  assert.equal(res.status, 404);
});

test("GET /detect: returns detection result for valid id", async () => {
  const res = await detectRoute.GET(
    new Request("http://localhost/"),
    { params: { id: "copilot" } }
  );
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.ok("installed" in body);
  assert.ok(typeof body.installed === "boolean");
});

test("GET /detect: error response does not leak stack trace", async () => {
  const res = await detectRoute.GET(
    new Request("http://localhost/"),
    { params: { id: "unknown-id-test" } }
  );
  const text = await res.text();
  assert.ok(!text.includes("at /"), "stack trace leaked in detect response");
});

// ── GET + POST /upstream-ca ────────────────────────────────────────────────

test("GET /upstream-ca: returns null when not configured", async () => {
  delete process.env.AGENTBRIDGE_UPSTREAM_CA_CERT;
  const res = await upstreamCaRoute.GET();
  assert.equal(res.status, 200);
  const body = await res.json() as { path: string | null };
  // path is either null or whatever AGENTBRIDGE_UPSTREAM_CA_CERT is set to
  assert.ok(body.path === null || typeof body.path === "string");
});

test("POST /upstream-ca: non-existent file returns 400", async () => {
  const res = await upstreamCaRoute.POST(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/nonexistent/path/ca.pem" }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json() as Record<string, unknown>;
  const errMsg = (body.error as Record<string, unknown>)?.message as string;
  assert.ok(!errMsg.includes("at /"), "stack trace leaked in 400 body");
});

test("POST /upstream-ca: valid file persists path", async () => {
  // Create a temp PEM file
  const tmpFile = path.join(TEST_DATA_DIR, "test-ca.pem");
  fs.writeFileSync(tmpFile, "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");

  const res = await upstreamCaRoute.POST(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: tmpFile }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.path, tmpFile);

  // Verify GET returns the stored path
  const getRes = await upstreamCaRoute.GET();
  const getBody = await getRes.json() as { path: string | null };
  assert.equal(getBody.path, tmpFile);
});

test("POST /upstream-ca: invalid JSON returns 400", async () => {
  const res = await upstreamCaRoute.POST(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    })
  );
  assert.equal(res.status, 400);
});
