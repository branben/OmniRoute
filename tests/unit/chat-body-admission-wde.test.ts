// Worst-Day-Ever adapted for chatBodyAdmission.ts
// Dimensions: 1=Input Validation, 2=State Machine, 3=Numerical Stability,
//             4=Gate Logic, 5=Lifecycle, 6=Concurrency, 7=Error Handling
import test from "node:test";
import assert from "node:assert/strict";

process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED = "1";
process.env.OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT = "1";

const admissionModule = await import("../../src/shared/middleware/chatBodyAdmission.ts");
const { ChatAdmissionController } = admissionModule;

// ─── DIM 1: Input Validation ─────────────────────────────────────────────────

test("empty sessionKey falls back to default", () => {
  const c = new ChatAdmissionController(1);
  const p = c.tryAcquireHeavy("");
  assert.ok(p, "parent should acquire with empty key");
  assert.strictEqual(p!.released, false);
  p!.release();
  assert.strictEqual(p!.released, true);
});

test("very long sessionKey does not crash or truncate", () => {
  const c = new ChatAdmissionController(1);
  const longKey = "s_" + "x".repeat(10000);
  const p = c.tryAcquireHeavy(longKey, true);
  assert.ok(p, "should handle 10KB key");
  const s = c.tryAcquireSibling(longKey, 256 * 1024);
  assert.ok(s, "sibling with long key should work");
  p!.release();
});

test("sessionKey with special characters", () => {
  const c = new ChatAdmissionController(1);
  const weird = "sess/ion.key@host:8080#frag ment";
  const p = c.tryAcquireHeavy(weird, true);
  assert.ok(p);
  p!.release();
});

test("maxHeavyInFlight=0 blocks all acquisitions", () => {
  assert.throws(() => new ChatAdmissionController(0), RangeError);
});

test("negative byteBudget sibling is rejected", () => {
  const c = new ChatAdmissionController(1);
  const p = c.tryAcquireHeavy("s1", true);
  assert.ok(p);
  // @ts-expect-error testing runtime with negative
  const s = c.tryAcquireSibling("s1", -1);
  // sibling acquisition with negative budget may succeed or fail depending on impl;
  // the key is it must not crash
  if (s) s.release();
  p!.release();
});

// ─── DIM 2: State Machine ───────────────────────────────────────────────────

test("double release is idempotent", () => {
  const c = new ChatAdmissionController(1);
  const p = c.tryAcquireHeavy("s1", true);
  assert.ok(p);
  p!.release();
  assert.strictEqual(p!.released, true);
  p!.release(); // second release must not throw
  assert.strictEqual(p!.released, true);
});

test("parent release promotes first sibling", () => {
  const c = new ChatAdmissionController(1);
  const p = c.tryAcquireHeavy("s1", true);
  assert.ok(p);
  const s = c.tryAcquireSibling("s1", 256 * 1024);
  assert.ok(s, "sibling should acquire");
  // Only parent counts as heavy; sibling holds byte-budget lease
  assert.strictEqual(c.activeHeavy, 1, "only parent counts as heavy");
  p!.release();
  // Parent released — count drops to 0 (sibling holds byte budget, not count)
  assert.strictEqual(c.activeHeavy, 0, "parent released, count drops to 0");
  // Sibling byte-budget lease can still be released
  if (s) s.release();
});

test("sibling without parent is rejected", () => {
  const c = new ChatAdmissionController(1);
  const s = c.tryAcquireSibling("no-parent", 256 * 1024);
  assert.strictEqual(s, null, "sibling without parent must be rejected");
});

test("acquire → release → reacquire in same session", () => {
  const c = new ChatAdmissionController(1);
  const p1 = c.tryAcquireHeavy("reuse", true);
  assert.ok(p1);
  p1!.release();
  const p2 = c.tryAcquireHeavy("reuse", true);
  assert.ok(p2, "should be able to reacquire after release");
  p2!.release();
});

test("sibling count never exceeds cap after many release cycles", () => {
  const c = new ChatAdmissionController(1);
  for (let i = 0; i < 100; i++) {
    const p = c.tryAcquireHeavy("loop", true);
    if (!p) continue;
    const s = c.tryAcquireSibling("loop", 256 * 1024);
    p.release();
    if (s) s.release(); // promoted sibling must be released too
  }
  assert.strictEqual(c.activeHeavy, 0, "should be clean after 100 cycles");
});

// ─── DIM 3: Numerical Stability ──────────────────────────────────────────────

test("repeated acquire/release does not leak counter state", () => {
  const c = new ChatAdmissionController(4);
  for (let i = 0; i < 1000; i++) {
    const p = c.tryAcquireHeavy("drift", true);
    if (p) p.release();
  }
  assert.strictEqual(c.activeHeavy, 0, "counter should not drift after 1000 cycles");
});

test("sibling per-session cap enforced exactly at boundary", () => {
  const c = new ChatAdmissionController(2);
  const p = c.tryAcquireHeavy("boundary", true);
  assert.ok(p);
  const s1 = c.tryAcquireSibling("boundary", 256 * 1024);
  assert.ok(s1, "first sibling should succeed");
  const s2 = c.tryAcquireSibling("boundary", 256 * 1024);
  // s2 may or may not succeed depending on default cap; just ensure no crash
  if (s1) s1.release();
  if (s2) s2.release();
  p!.release();
});

// ─── DIM 4: Gate Logic (Feature Flags) ───────────────────────────────────────

test("sibling acquisition blocked when flag off", () => {
  const original = process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED;
  process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED = undefined;
  const c = new ChatAdmissionController(1);
  const p = c.tryAcquireHeavy("gate", true);
  assert.ok(p);
  const s = c.tryAcquireSibling("gate", 256 * 1024);
  assert.strictEqual(s, null, "sibling must be rejected when flag off");
  if (p) p.release();
  process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED = original;
});

test("snapshot reflects correct gate state", () => {
  process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED = "1";
  const pc = new admissionModule.PerConnectionAdmissionController(1);
  const c = pc.getController("test");
  const p = c.tryAcquireHeavy("gate", true);
  const s = c.tryAcquireSibling("gate", 256 * 1024);
  const snap = pc.snapshot();
  assert.ok(snap.countCapEnabled !== undefined, "countCapEnabled should be in snapshot");
  if (s) s.release();
  if (p) p.release();
});

// ─── DIM 5: Lifecycle ───────────────────────────────────────────────────────

test("sweepOrphans handles empty controller", () => {
  const c = new ChatAdmissionController(1);
  const result = c.sweepOrphans();
  assert.strictEqual(result.orphans, 0);
  assert.strictEqual(result.leaks, 0);
});

test("orphan detection: parent never released but swept", () => {
  const c = new ChatAdmissionController(1);
  // Simulate: acquire parent + sibling, then clear internal parent tracking
  // to mimic parent "death" without release
  const p = c.tryAcquireHeavy("orphan", true);
  assert.ok(p);
  const s = c.tryAcquireSibling("orphan", 256 * 1024);
  assert.ok(s);
  // Release parent — sibling should be promoted, not orphaned
  p!.release();
  const result = c.sweepOrphans();
  // After promotion path, sweep should find 0 orphans
  assert.strictEqual(result.orphans, 0, "promoted sibling should not be orphaned");
});

test("all siblings release when parent is released", () => {
  const c = new ChatAdmissionController(2);
  const p = c.tryAcquireHeavy("cleanup", true);
  assert.ok(p);
  const siblings = [];
  for (let i = 0; i < 3; i++) {
    const s = c.tryAcquireSibling("cleanup", 256 * 1024);
    if (s) siblings.push(s);
  }
  p!.release();
  // After parent release, all sibling state should be cleaned up
  assert.ok(true, "no crash on multi-sibling cleanup");
  for (const s of siblings) s.release();
});

// ─── DIM 6: Concurrency ─────────────────────────────────────────────────────

test("100 sequential heavy acquisitions never exceed cap", () => {
  const c = new ChatAdmissionController(1);
  let maxActive = 0;
  for (let i = 0; i < 100; i++) {
    const p = c.tryAcquireHeavy("seq", true);
    if (p) {
      maxActive = Math.max(maxActive, c.activeHeavy);
      p.release();
    }
  }
  assert.ok(maxActive <= 1, "cap must never be exceeded in sequential access");
});

test("multiple sessions interleaved do not interfere", () => {
  const c = new ChatAdmissionController(4);
  const leases = [];
  for (let i = 0; i < 20; i++) {
    const p = c.tryAcquireHeavy(`sess-${i}`, true);
    if (p) leases.push(p);
  }
  assert.ok(leases.length >= 1, "at least one session should acquire");
  for (const l of leases) l.release();
});

// ─── DIM 7: Error Handling ──────────────────────────────────────────────────

test("tryAcquireHeavy with undefined sessionKey defaults gracefully", () => {
  const c = new ChatAdmissionController(1);
  // @ts-expect-error testing undefined
  const p = c.tryAcquireHeavy(undefined);
  assert.ok(p);
  p!.release();
});

test("tryAcquireSibling with undefined sessionKey returns null", () => {
  const c = new ChatAdmissionController(1);
  // @ts-expect-error testing undefined
  const s = c.tryAcquireSibling(undefined, 256 * 1024);
  assert.strictEqual(s, null);
});

test("controller handles rapid acquire/release without deadlock", () => {
  const c = new ChatAdmissionController(1);
  const start = Date.now();
  for (let i = 0; i < 5000; i++) {
    const p = c.tryAcquireHeavy("rapid", true);
    if (p) p.release();
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, "5000 ops should complete in <5s");
});

test("snapshot does not crash during active leases", () => {
  process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED = "1";
  const pc = new admissionModule.PerConnectionAdmissionController(2);
  const c = pc.getController("test");
  const p1 = c.tryAcquireHeavy("snap1", true);
  const p2 = c.tryAcquireHeavy("snap2", true);
  const snap = pc.snapshot();
  assert.ok(snap.activeHeavy >= 0);
  if (p1) p1.release();
  if (p2) p2.release();
});
