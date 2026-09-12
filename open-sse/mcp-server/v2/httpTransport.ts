/**
 * MCP v2 HTTP Transport — /api/mcp/v2/stream and /api/mcp/v2/sse
 *
 * Wires v2 sidecar through the same httpAuthContext plumbing as v1.
 * This populates extra.authInfo from the API key, so scope enforcement
 * sees real per-key scopes instead of falling back to _meta or env vars.
 */

import { randomUUID } from "node:crypto";
import { createMcpServerV2 } from "./server.ts";
import { resolveMcpCallerAuthInfo, withMcpHttpAuthContext } from "../httpAuthContext.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let _sseServer: McpServer | null = null;
let _sseTransport: WebStandardStreamableHTTPServerTransport | null = null;

type StreamableSession = {
  sessionId: string;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  startedAt: number;
  lastActivityAt: number;
};

const _streamableSessions = new Map<string, StreamableSession>();

const MCP_SESSION_IDLE_MS = 5 * 60 * 1000;

const _mcpSessionSweep = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of _streamableSessions) {
    if (now - session.lastActivityAt > MCP_SESSION_IDLE_MS) {
      try {
        closeStreamableSession(sessionId);
      } catch {}
    }
  }
}, 60_000);
if (typeof _mcpSessionSweep === "object" && "unref" in _mcpSessionSweep) {
  (_mcpSessionSweep as { unref?: () => void }).unref?.();
}

function closeSseTransport(): void {
  if (_sseTransport) {
    try { _sseTransport.close(); } catch {}
  }
  _sseServer = null;
  _sseTransport = null;
}

function closeStreamableSession(sessionId: string): void {
  const session = _streamableSessions.get(sessionId);
  if (!session) return;
  try { session.transport.close(); } catch {}
  _streamableSessions.delete(sessionId);
}

function closeAllStreamableSessions(): void {
  for (const sessionId of _streamableSessions.keys()) closeStreamableSession(sessionId);
}

function ensureSseServer(): { server: McpServer; transport: WebStandardStreamableHTTPServerTransport } {
  if (_sseServer && _sseTransport) return { server: _sseServer, transport: _sseTransport };
  closeAllStreamableSessions();
  _sseServer = createMcpServerV2().server;
  _sseTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  void _sseServer.connect(_sseTransport);
  console.log("[MCP v2] HTTP transport started (sse)");
  return { server: _sseServer, transport: _sseTransport };
}

function createStreamableSession(): StreamableSession {
  closeSseTransport();
  const sessionId = randomUUID();
  const server = createMcpServerV2().server;
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
  const session = { sessionId, server, transport, startedAt: Date.now(), lastActivityAt: Date.now() };
  void server.connect(transport);
  _streamableSessions.set(sessionId, session);
  console.log(`[MCP v2] HTTP transport started (streamable-http:${sessionId})`);
  return session;
}

async function isDiscoverRequest(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    const body = (await request.clone().json()) as { method?: unknown };
    return body?.method === "server/discover";
  } catch { return false; }
}

async function handleRequestWithAuthInfo(
  transport: WebStandardStreamableHTTPServerTransport,
  request: Request
): Promise<Response> {
  const authInfo = await resolveMcpCallerAuthInfo(request);
  return transport.handleRequest(request, { authInfo });
}

function errorResponse(message: string, code: number, status = 400): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function protectMcpSseResponse(request: Request, response: Response): Response {
  if (request.method !== "POST" || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return response;
  const headers = new Headers(response.headers);
  const cacheControl = headers.get("cache-control");
  if (!/(?:^|,)\s*no-transform(?:\s*(?:,|$))/i.test(cacheControl ?? "")) {
    headers.set("cache-control", [cacheControl, "no-transform"].filter(Boolean).join(", "));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withSessionHeader(response: Response, sessionId: string): Response {
  if (response.headers.get("mcp-session-id")) return response;
  const headers = new Headers(response.headers);
  headers.set("mcp-session-id", sessionId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleStreamableRequest(request: Request): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id");

  if (sessionId) {
    const session = _streamableSessions.get(sessionId);
    if (!session) {
      if (await isDiscoverRequest(request)) {
        const newSession = createStreamableSession();
        try {
          const response = await withMcpHttpAuthContext(request, () =>
            handleRequestWithAuthInfo(newSession.transport, request)
          );
          return withSessionHeader(response, newSession.sessionId);
        } catch (err) {
          closeStreamableSession(newSession.sessionId);
          console.error("[MCP v2] error during stale-session recovery:", err);
          return new Response(JSON.stringify({ error: "MCP v2 transport error" }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
      }
      return errorResponse("Not Found: Unknown Mcp-Session-Id header", -32000, 404);
    }
    try {
      session.lastActivityAt = Date.now();
      const response = await withMcpHttpAuthContext(request, () => handleRequestWithAuthInfo(session.transport, request));
      if (request.method === "DELETE") closeStreamableSession(sessionId);
      return withSessionHeader(response, sessionId);
    } catch (err) {
      console.error("[MCP v2] Streamable HTTP error:", err);
      if (request.method === "DELETE") closeStreamableSession(sessionId);
      return new Response(JSON.stringify({ error: "MCP v2 transport error" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }

  if (!(await isDiscoverRequest(request))) return errorResponse("Bad Request: Mcp-Session-Id header is required", -32000);

  const session = createStreamableSession();
  try {
    const response = await withMcpHttpAuthContext(request, () => handleRequestWithAuthInfo(session.transport, request));
    return withSessionHeader(response, session.sessionId);
  } catch (err) {
    closeStreamableSession(session.sessionId);
    console.error("[MCP v2] Streamable HTTP error:", err);
    return new Response(JSON.stringify({ error: "MCP v2 transport error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

export async function handleMcpV2StreamableHTTP(request: Request): Promise<Response> {
  return protectMcpSseResponse(request, await handleStreamableRequest(request));
}

export async function handleMcpV2SSE(request: Request): Promise<Response> {
  const { transport } = ensureSseServer();
  try {
    const response = await withMcpHttpAuthContext(request, () => handleRequestWithAuthInfo(transport, request));
    return protectMcpSseResponse(request, response);
  } catch (err) {
    console.error("[MCP v2] SSE error:", err);
    return new Response(JSON.stringify({ error: "MCP v2 SSE transport error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
