import test from "node:test";
import assert from "node:assert/strict";
import {ProtectionEngine} from "../extension/engine.mjs";

const epoch = 1800000000;
const frame = (qty, id = "ES") => ({event: "positionUpdates", data: {positions: [{id, qty, accountId: "external-A", lastModified: 10}]}});
function harness(saved) {
  const h = {saved: structuredClone(saved), remote: null, seconds: epoch, ms: 0,
    puts: [], guards: [], views: [], failPut: false, failGet: false, failSave: false,
    acknowledgedOnly: false, snapshots: [], apiCalls: []};
  h.storage = {load: async () => structuredClone(h.saved), save: async state => {
    if (h.failSave) throw new Error("Storage unavailable");
    h.saved = structuredClone(state);
  }};
  h.api = {
    account: async () => { h.apiCalls.push("account"); return {externalAccountId: "external-A", accountName: "Test account", readHost: "prod-trade-read.tradesea.ai", serverNow: h.seconds}; },
    getLock: async () => { h.apiCalls.push("getLock"); if (h.failGet) throw new Error("Offline"); return {remote: h.remote, serverNow: h.seconds}; },
    snapshot: async () => { h.apiCalls.push("snapshot"); return {frame: {event: "unifiedSnapshot", positions: h.snapshots}, serverNow: h.seconds}; },
    setLock: async (id, lock) => {
      assert.deepEqual(h.saved.lock, lock, "the intended deadline is durable BEFORE PUT");
      assert.equal(id, "internal-A");
      h.puts.push(structuredClone(lock));
      if (h.failPut) throw new Error("Offline");
      if (!h.acknowledgedOnly) h.remote = {start: lock.start, end: lock.end};
      return {remote: h.remote, serverNow: h.seconds};
    }
  };
  h.make = () => new ProtectionEngine({accountId: "internal-A", storage: h.storage, api: h.api,
    guard: async active => { h.guards.push(active); }, publish: async view => { h.views.push(view); }, monotonic: () => h.ms});
  h.engine = h.make();
  return h;
}

test("engine completes one trade and persists confirmation", async () => {
  const h = harness();
  assert.equal((await h.engine.maintain()).status, "ready");
  await h.engine.receive(frame(1));
  const view = await h.engine.receive(frame(0));
  assert.equal(view.status, "locked");
  assert.equal(h.puts.length, 1);
  assert.equal(h.saved.lock.end, epoch + 28800);
  assert.equal(h.guards.at(-1), true);
});
test("concurrent close events submit a single lockout", async () => {
  const h = harness();
  await h.engine.maintain();
  await h.engine.receive(frame(1));
  await Promise.all(Array.from({length: 12}, () => h.engine.receive(frame(0))));
  assert.equal(h.puts.length, 1);
});
test("network failure survives a worker restart and retries the original deadline", async () => {
  const h = harness();
  await h.engine.maintain();
  await h.engine.receive(frame(1));
  h.failPut = true;
  assert.equal((await h.engine.receive(frame(0))).status, "error");
  const end = h.saved.lock.end;
  h.seconds += 30;
  h.failPut = false;
  h.engine = h.make();
  assert.equal((await h.engine.maintain({force: true})).status, "locked");
  assert.equal(h.saved.lock.end, end);
  assert.equal(h.puts.at(-1).end, end);
});
test("a five-second remote replacement is repaired using the recorded deadline", async () => {
  const h = harness();
  await h.engine.maintain();
  await h.engine.receive(frame(1));
  await h.engine.receive(frame(0));
  h.remote.end = epoch + 5;
  await h.engine.maintain({force: true});
  assert.equal(h.remote.end, epoch + 28800);
  assert.equal(h.puts.length, 2);
});
test("existing longer server locks are preserved without PUT", async () => {
  const h = harness();
  h.remote = {start: epoch - 10, end: epoch + 40000};
  assert.equal((await h.engine.maintain()).status, "locked");
  assert.equal(h.saved.lock.end, epoch + 40000);
  assert.equal(h.puts.length, 0);
});
test("server acknowledgement without persisted lock does not claim success", async () => {
  const h = harness();
  await h.engine.maintain();
  await h.engine.receive(frame(1));
  h.acknowledgedOnly = true;
  assert.equal((await h.engine.receive(frame(0))).status, "error");
  assert.equal(h.saved.lock.confirmed, false);
});
test("storage failure prevents sending an unrecorded deadline", async () => {
  const h = harness();
  await h.engine.maintain();
  await h.engine.receive(frame(1));
  h.failSave = true;
  assert.equal((await h.engine.receive(frame(0))).status, "error");
  assert.equal(h.puts.length, 0);
});
test("changed local wall clock cannot expire a server lock", async () => {
  const h = harness();
  await h.engine.maintain();
  await h.engine.receive(frame(1));
  await h.engine.receive(frame(0));
  h.ms = 40000 * 1000; // Even an elapsed-time jump only affects the display.
  assert.equal((await h.engine.maintain({force: true})).status, "locked");
  h.seconds = epoch + 28800;
  assert.equal((await h.engine.maintain({force: true})).status, "ready");
  assert.equal(h.guards.at(-1), false);
});
test("open trade persisted across restart locks when the reconnect snapshot is flat", async () => {
  const h = harness();
  await h.engine.maintain();
  await h.engine.receive(frame(1));
  h.engine = h.make();
  assert.equal((await h.engine.maintain({force: true})).status, "locked");
});
test("server-check failure is visible and does not erase an existing deadline", async () => {
  const h = harness();
  await h.engine.maintain();
  await h.engine.receive(frame(1));
  await h.engine.receive(frame(0));
  h.failGet = true;
  const view = await h.engine.maintain({force: true});
  assert.equal(view.status, "error");
  assert.equal(view.accountName, "Test account");
  assert.equal(view.end, epoch + 28800);
  assert.equal(h.saved.lock.end, epoch + 28800);
});
test("a missed, unconfirmed deadline never silently re-arms trading", async () => {
  const h = harness();
  await h.engine.maintain();
  await h.engine.receive(frame(1));
  h.failPut = true;
  await h.engine.receive(frame(0));
  h.failPut = false;
  h.seconds += 30000;
  assert.equal((await h.engine.maintain({force: true})).status, "error");
  assert.equal(h.saved.lock.end, epoch + 28800);
});
