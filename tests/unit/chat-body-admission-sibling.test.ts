// #13648: session-aware admission slots — sibling tests
import test from "node:test";
import assert from "node:assert/strict";

const admissionModule = await import("../../src/shared/middleware/chatBodyAdmission.ts");
const { ChatAdmissionController, PerConnectionAdmissionController } = admissionModule;

test("sibling lease interface exists", () => {
  const controller = new ChatAdmissionController(1);
  assert.ok(controller);
});

test("tryAcquireHeavy accepts sessionKey and isParent params", () => {
  const controller = new ChatAdmissionController(1);
  const lease = controller.tryAcquireHeavy("session-1", true);
  assert.ok(lease);
  assert.equal(lease?.sessionKey, "session-1");
  lease?.release();
  assert.equal(controller.activeHeavy, 0);
});

test("parent lease tracks siblings on release", () => {
  const controller = new ChatAdmissionController(1);
  const parent = controller.tryAcquireHeavy("sess-1", true);
  assert.ok(parent);
  parent?.release();
  assert.equal(controller.activeHeavy, 0);
});

test("hasParentLease returns false when no parent", () => {
  const controller = new ChatAdmissionController(1);
  assert.equal(controller.hasParentLease("sess-1"), false);
});

test("hasParentLease returns true when parent exists", () => {
  const controller = new ChatAdmissionController(1);
  const parent = controller.tryAcquireHeavy("sess-1", true);
  assert.ok(parent);
  assert.equal(controller.hasParentLease("sess-1"), true);
  parent?.release();
  assert.equal(controller.hasParentLease("sess-1"), false);
});

test("tryAcquireSibling returns null when feature flag off", () => {
  const original = process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED;
  delete process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED;

  const controller = new ChatAdmissionController(1);
  const parent = controller.tryAcquireHeavy("sess-1", true);
  assert.ok(parent);

  const sibling = controller.tryAcquireSibling("sess-1", 1024);
  assert.equal(sibling, null);

  parent?.release();
  if (original !== undefined) {
    process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED = original;
  }
});

test("tryAcquireSibling returns null when no parent", () => {
  process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED = "1";
  const controller = new ChatAdmissionController(1);

  const sibling = controller.tryAcquireSibling("no-parent", 1024);
  assert.equal(sibling, null);
  delete process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED;
});

test("tryAcquireSibling succeeds when parent exists and flag on", () => {
  process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED = "1";
  const controller = new ChatAdmissionController(1);

  const parent = controller.tryAcquireHeavy("sess-1", true);
  assert.ok(parent);

  const sibling = controller.tryAcquireSibling("sess-1", 1024);
  assert.ok(sibling);
  assert.equal(sibling?.sessionId, "sess-1");
  assert.equal(controller.activeSiblings, 1);

  sibling?.release();
  assert.equal(controller.activeSiblings, 0);

  parent?.release();
  delete process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED;
});

test("tryAcquireSibling respects max siblings cap", () => {
  process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED = "1";
  process.env.OMNIROUTE_CHAT_SESSION_MAX_SIBLINGS = "2";
  const controller = new ChatAdmissionController(1);

  const parent = controller.tryAcquireHeavy("sess-1", true);
  assert.ok(parent);

  const s1 = controller.tryAcquireSibling("sess-1", 1024);
  const s2 = controller.tryAcquireSibling("sess-1", 1024);
  const s3 = controller.tryAcquireSibling("sess-1", 1024);

  assert.ok(s1);
  assert.ok(s2);
  assert.equal(s3, null);
  assert.equal(controller.activeSiblings, 2);

  s1?.release();
  s2?.release();
  parent?.release();
  delete process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED;
  delete process.env.OMNIROUTE_CHAT_SESSION_MAX_SIBLINGS;
});

test("parent release cleans up tracking (no promotion needed)", () => {
  process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED = "1";
  const controller = new ChatAdmissionController(1);

  const parent = controller.tryAcquireHeavy("sess-1", true);
  assert.ok(parent);

  const sibling = controller.tryAcquireSibling("sess-1", 1024);
  assert.ok(sibling);
  assert.equal(controller.activeSiblings, 1);

  // Parent release just cleans up parent tracking — sibling holds byte-budget lease
  parent?.release();
  assert.equal(controller.activeSiblings, 1, "sibling remains as sibling (byte-budget lease)");
  assert.equal(controller.activeHeavy, 0, "parent heavy lease released");

  sibling.release();
  assert.equal(controller.activeSiblings, 0, "sibling released");

  delete process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED;
});

test("sweepOrphans returns zero when parent is alive", () => {
  process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED = "1";
  const controller = new ChatAdmissionController(1);

  const parent = controller.tryAcquireHeavy("sess-1", true);
  assert.ok(parent);

  const sibling = controller.tryAcquireSibling("sess-1", 1024);
  assert.ok(sibling);
  assert.equal(controller.activeSiblings, 1);

  // Parent is alive — no orphans
  const result = controller.sweepOrphans();
  assert.equal(result.orphans, 0);
  assert.equal(controller.activeSiblings, 1);

  sibling?.release();
  parent?.release();
  delete process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED;
});

test("existing tryAcquireHeavy behavior unchanged without params", () => {
  const controller = new ChatAdmissionController(1);
  const lease = controller.tryAcquireHeavy();
  assert.ok(lease);
  assert.equal(lease.sessionKey, undefined);
  assert.equal(controller.activeHeavy, 1);
  lease.release();
  assert.equal(controller.activeHeavy, 0);
});

test("multiple heavy leases respect maxHeavyInFlight", () => {
  const controller = new ChatAdmissionController(2);
  const lease1 = controller.tryAcquireHeavy("sess-1");
  const lease2 = controller.tryAcquireHeavy("sess-2");
  const lease3 = controller.tryAcquireHeavy("sess-3");
  assert.ok(lease1);
  assert.ok(lease2);
  assert.equal(lease3, null);
  lease1?.release();
  lease2?.release();
  assert.equal(controller.activeHeavy, 0);
});

test("snapshot includes sibling fields via PerConnectionAdmissionController", () => {
  process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED = "1";

  // PerConnectionAdmissionController takes (maxHeavyInFlight, opts)
  const pc = new PerConnectionAdmissionController(1);
  const controller = pc.getController("sess-1");

  const parent = controller.tryAcquireHeavy("sess-1", true);
  const sibling = controller.tryAcquireSibling("sess-1", 1024);

  const snap = pc.snapshot();

  assert.equal(snap.activeSiblings, 1);
  assert.equal(snap.siblingsBySession.length, 1);
  assert.equal(snap.siblingsBySession[0].sessionId, "sess-1");
  assert.equal(snap.siblingsBySession[0].count, 1);

  sibling?.release();
  parent?.release();
  delete process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED;
});

test("sibling lease has released property", () => {
  process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED = "1";
  const controller = new ChatAdmissionController(1);

  const parent = controller.tryAcquireHeavy("sess-1", true);
  const sibling = controller.tryAcquireSibling("sess-1", 1024);

  assert.ok(sibling);
  assert.equal(sibling.released, false);
  sibling?.release();
  assert.equal(sibling.released, true);

  parent?.release();
  delete process.env.OMNIROUTE_CHAT_SESSION_SIBLINGS_ENABLED;
});
