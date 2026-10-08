/**
 * Guard: the v2 sidecar must LINK under real Node ESM.
 *
 * Why this exists separately from the vitest suite: vitest transforms modules and
 * tolerates a missing named export (it becomes undefined at call time, or is
 * elided). Real Node does not — it throws at link time:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: The requested module '../server.ts'
 *   does not provide an export named 'toArray'
 *
 * So a v2 module can show 40/40 GREEN under vitest and still be unloadable by
 * `node --import tsx bin/mcp-server.mjs`. This test spawns a real Node process
 * and asserts the module graph resolves.
 */

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

const V2_ENTRY = join(REPO_ROOT, "open-sse", "mcp-server", "v2", "server.ts");
const BARREL_ENTRY = join(REPO_ROOT, "open-sse", "mcp-server", "index.ts");

/** Import an entry through real Node ESM (tsx handles the TS). */
async function importViaNode(entry: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `const m = await import(${JSON.stringify(entry)});
         const names = Object.keys(m).sort().join(",");
         process.stdout.write("OK:" + names);`,
      ],
      { cwd: REPO_ROOT, timeout: 60_000 }
    );
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message}` };
  }
}

describe("v2 sidecar — real ESM link", () => {
  it("v2/server.ts loads under Node ESM (not just vitest's transform)", async () => {
    const { ok, output } = await importViaNode(V2_ENTRY);
    expect(
      ok,
      `v2/server.ts failed to link under real Node ESM:\n${output}\n\n` +
        `If this says "does not provide an export named X", the fix is to export X ` +
        `from the module v2 imports it from — not to loosen the test.`
    ).toBe(true);
    expect(output).toContain("OK:");
  }, 90_000);

  it("the mcp-server barrel links under Node ESM and re-exports the v2 surface", async () => {
    const { ok, output } = await importViaNode(BARREL_ENTRY);
    expect(ok, `mcp-server/index.ts failed to link under real Node ESM:\n${output}`).toBe(true);
    // The barrel must expose the v2 factory, or `import { createMcpServerV2 }`
    // from the package entry point is undefined for every consumer.
    expect(output).toContain("createMcpServerV2");
    expect(output).toContain("startMcpStdioV2");
  }, 90_000);
});
