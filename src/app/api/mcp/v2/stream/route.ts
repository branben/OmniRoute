/**
 * MCP v2 Streamable HTTP Transport — /api/mcp/v2/stream
 *
 * Endpoints:
 *   POST   — send JSON-RPC messages to the MCP v2 server
 *   GET    — open SSE stream for server-initiated messages
 *   DELETE — end session
 */

import { NextRequest, NextResponse } from "next/server";
import { getCachedSettings } from "@/lib/db/settings";
import { handleMcpV2StreamableHTTP } from "../../../../../../open-sse/mcp-server/v2/httpTransport";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

async function guardEnabled(): Promise<NextResponse | null> {
  const settings = await getCachedSettings();
  if (!settings.mcpEnabled) {
    return NextResponse.json(
      { error: "MCP server is disabled. Enable it from the Endpoints page." },
      { status: 503 }
    );
  }
  const transport = (settings.mcpTransport as string) || "stdio";
  if (transport !== "v2-streamable-http" && transport !== "v2-sse") {
    return NextResponse.json(
      {
        error: `MCP transport is set to "${transport}", not "v2-streamable-http" or "v2-sse". Change it from Settings.`,
      },
      { status: 400 }
    );
  }
  return null;
}

export async function POST(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const blocked = await guardEnabled();
  if (blocked) return blocked;
  return handleMcpV2StreamableHTTP(request);
}

export async function GET(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const blocked = await guardEnabled();
  if (blocked) return blocked;
  return handleMcpV2StreamableHTTP(request);
}

export async function DELETE(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const blocked = await guardEnabled();
  if (blocked) return blocked;
  return handleMcpV2StreamableHTTP(request);
}
