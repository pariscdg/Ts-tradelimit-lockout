import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {newState, validateState, applyPositions, parseFrame, quantity, reconcileLock,
  readServerLock, LOCK_SECONDS, streamInfo, lockRule} from "../extension/core.mjs";

const now = 1800000000;
const flatDemo = JSON.parse(await readFile(new URL("./fixtures/flat-demo-snapshot.json", import.meta.url), "utf8"));
const pos = (id, qty, accountId = "external-A", lastModified = 1) => ({id, qty, accountId, lastModified});
function seeded(positions = []) {
  const state = {...newState("internal-A"), externalAccountId: "external-A"};
  return applyPositions(state, {event: "unifiedSnapshot", positions}, now).state;
}
const update = (state, positions, time = now) => applyPositions(state, {event: "positionUpdates", positions}, time);

test("one full round trip fixes the deadline at exactly eight hours", () => {
  let state = update(seeded(), [pos("ES", 2)]).state;
  const result = update(state, [pos("ES", 0, "external-A", 2)]);
  assert.equal(result.triggered, true);
  assert.equal(result.state.lock.end - result.state.lock.start, 28800);
  assert.equal(LOCK_SECONDS, 28800);
  assert.equal(result.state.lock.confirmed, false);
  assert.equal(update(result.state, [pos("ES", 0, "external-A", 3)], now + 100).state.lock.end, now + 28800);
});
test("partial exits, multiple instruments, and hedged quantities do not look flat", () => {
  let state = seeded([pos("ES", 2), pos("NQ", -2)]);
  assert.equal(quantity(state), 4);
  state = update(state, [pos("ES", 1)]).state;
  assert.equal(state.lock, null);
  state = update(state, [pos("ES", 0)]).state;
  assert.equal(state.lock, null);
  assert.equal(update(state, [pos("NQ", 0)]).triggered, true);
});
test("empty delta does not close a position; empty complete snapshot does", () => {
  const state = seeded([pos("ES", 1)]);
  assert.equal(update(state, []).state.lock, null);
  assert.equal(applyPositions(state, {event: "unifiedSnapshot", positions: []}, now).triggered, true);
});
test("other account activity cannot open or close the protected account", () => {
  let state = seeded([pos("ES", 1), pos("ES", 9, "external-B")]);
  state = update(state, [pos("ES", 0, "external-B")]).state;
  assert.equal(quantity(state), 1);
  assert.equal(state.lock, null);
});
test("malformed quantities and missing arrays do not trigger a false close", () => {
  const state = seeded([pos("ES", 1)]);
  for (const qty of [undefined, null, "", " ", false, "bad", NaN, Infinity]) {
    assert.throws(() => update(state, [pos("ES", qty)]));
    assert.equal(state.lock, null);
  }
  assert.throws(() => update(state, undefined));
  assert.throws(() => update(state, [{id: "ES", qty: 0}]));
});
test("numeric strings are accepted and stale per-position changes are ignored", () => {
  const state = seeded([pos("ES", "2", "external-A", 20)]);
  assert.equal(quantity(state), 2);
  assert.equal(update(state, [pos("ES", 0, "external-A", 19)]).triggered, false);
});
test("deltas before a baseline never claim the account is flat", () => {
  const state = {...newState("internal-A"), externalAccountId: "external-A", hasOpen: true};
  assert.equal(update(state, [pos("ES", 0)]).triggered, false);
});
test("a persisted open trade is detected flat after a reload snapshot", () => {
  const state = {...seeded([pos("ES", 1)]), snapshotReady: false};
  assert.equal(applyPositions(state, {event: "unifiedSnapshot", positions: []}, now).triggered, true);
});
test("parse both object and JSON-string payloads, ignore unrelated traffic", () => {
  assert.equal(parseFrame(JSON.stringify({event: "positionUpdates", data: JSON.stringify({positions: []})})).event, "positionUpdates");
  assert.equal(parseFrame({event: "orderUpdates", data: {orders: []}}), null);
  assert.equal(parseFrame("not-json"), null);
});
test("server response must indicate success and contain valid lockout data", () => {
  assert.equal(readServerLock({status: "success", data: {sessionMetaData: []}}), null);
  for (const body of [{status: "error", data: {}}, {status: "ok"}, {status: "ok", data: {lockoutStartTimeEpoch: now}}]) {
    assert.throws(() => readServerLock(body));
  }
});
test("a shorter server lock cannot shorten the saved eight-hour deadline", () => {
  let state = update(seeded([pos("ES", 1)]), [pos("ES", 0)]).state;
  state = reconcileLock(state, {start: now, end: now + 5}, now + 1);
  assert.equal(state.lock.end, now + 28800);
  assert.equal(state.lock.confirmed, false);
  state = reconcileLock(state, {start: now, end: now + 40000}, now + 2);
  assert.equal(state.lock.end, now + 40000);
  assert.equal(state.lock.confirmed, true);
});
test("only a server check after a confirmed deadline permits re-arming", () => {
  let state = update(seeded([pos("ES", 1)]), [pos("ES", 0)]).state;
  assert.notEqual(reconcileLock(state, null, now + 50000).lock, null, "unconfirmed locks require attention");
  state = reconcileLock(state, {start: now, end: now + 28800}, now);
  state = reconcileLock(state, null, now + 28800);
  assert.equal(state.lock, null);
  assert.equal(state.snapshotReady, false);
});
test("existing server lock is recovered after local storage loss", () => {
  const state = reconcileLock(seeded(), {start: now - 30, end: now + 20000}, now);
  assert.equal(state.lock.reason, "existing");
  assert.equal(state.lock.end, now + 20000);
});
test("a future scheduled lockout is not moved forward without a completed trade", () => {
  assert.throws(() => reconcileLock(seeded(), {start: now + 500, end: now + 20000}, now), /future personal lockout/);
});
test("server normalization of the start time is accepted once the full lock is active", () => {
  const state = update(seeded([pos("ES", 1)]), [pos("ES", 0)]).state;
  assert.equal(reconcileLock(state, {start: now + 1, end: now + 28800}, now + 2).lock.confirmed, true);
});
test("tampered, corrupt, or repointed saved state is not silently reset", () => {
  const state = seeded();
  assert.equal(validateState(state, "internal-A"), state);
  assert.throws(() => validateState(state, "internal-B"));
  assert.throws(() => validateState({}, "internal-A"));
  assert.throws(() => validateState({...state, lock: {start: now, end: now + 5, reason: "trade", confirmed: true}}, "internal-A"));
});
test("socket URLs are limited to TradeSea and lock guards exclude extension requests", () => {
  assert.deepEqual(streamInfo("wss://prod-trade-read.tradesea.ai/v1/users/internal-A/ws/unified?x=1"), {accountId: "internal-A", host: "prod-trade-read.tradesea.ai"});
  assert.equal(streamInfo("wss://evil.example/v1/users/internal-A/ws/unified"), null);
  const rule = lockRule("internal-A", "extension-id");
  assert.equal(rule.condition.urlFilter, "|https://prod-identity.tradesea.ai/eum/v1/prop-fund/internal-A/lockout^");
  assert.deepEqual(rule.condition.excludedInitiatorDomains, ["extension-id"]);
  assert.equal(rule.condition.requestMethods.includes("get"), false);
});

test("the reported flat demo snapshot establishes a baseline without treating order history as a new trade", () => {
  const state = {...newState("A"), externalAccountId: "external-A"};
  const result = applyPositions(state, parseFrame(flatDemo), now);
  assert.equal(result.state.snapshotReady, true);
  assert.equal(result.state.hasOpen, false);
  assert.equal(result.triggered, false);
  assert.equal(result.state.lock, null);
});

test("a complete snapshot with omitted positions closes a recorded trade only for its identified account", () => {
  const state = seeded([pos("ES", 1)]);
  const result = applyPositions(state, parseFrame(flatDemo), now);
  assert.equal(result.triggered, true);
  assert.equal(result.state.lock.end, now + 28800);
  assert.throws(() => applyPositions({...state, externalAccountId: "other"}, parseFrame(flatDemo), now));
  assert.throws(() => applyPositions(state, parseFrame({...flatDemo, event: "positionUpdates"}), now));
});
