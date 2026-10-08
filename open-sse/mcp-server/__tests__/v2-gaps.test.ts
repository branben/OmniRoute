/**
 * RED test for Task 1: createMcpServerV2 and startMcpStdioV2 exported from index.ts
 */
import { describe, it, expect } from "vitest";
import { createMcpServerV2, startMcpStdioV2 } from "../index.js";

describe("Task 1 — v2 barrel exports", () => {
  it("exports createMcpServerV2", () => {
    expect(typeof createMcpServerV2).toBe("function");
  });

  it("exports startMcpStdioV2", () => {
    expect(typeof startMcpStdioV2).toBe("function");
  });
});
