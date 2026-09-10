import test from "node:test";
import assert from "node:assert/strict";
import {ProtectionManager, validateLedger} from "../extension/manager.mjs";
import {newState, lockRule} from "../extension/core.mjs";

const epoch = 1800000000;
const host = "prod-trade-read.tradesea.ai";
const stateA = () => ({...newState("A"), externalAccountId: "external-A", readHost: host, accountName: "Account A"});
const position = (id, qty) => ({id: "ES", accountId: `external-${id}`, qty, lastModified: 10});
function fixture(saved, configuredAccountId = "A") {
  const h = {saved: structuredClone(saved), now: epoch, puts: [], calls: [], rules: new Map(),
    remote: {}, positions: {}, failed: new Set(), failedSnapshots: new Set(), failPut: false, failSave: false,
    accounts: ["A", "B", "C"].map(id => ({accountId: id, externalAccountId: `external-${id}`, readHost: host,
      accountName: `Account ${id}`, serverNow: epoch, restricted: false}))};
  h.api = {
    accounts: async () => structuredClone(h.accounts),
    account: async (id, reference = {}) => {
      const matches = h.accounts.filter(account => reference.externalAccountId
        ? account.externalAccountId === reference.externalAccountId && account.readHost === reference.readHost
        : account.accountId === id);
      if (matches.length !== 1) throw new Error("Account unavailable");
      return {...matches[0], serverNow: h.now};
    },
    getLock: async id => {
      h.calls.push({operation: "lock", id});
      if (h.failed.has(id)) throw new Error("Offline");
      return {remote: structuredClone(h.remote[id] ?? null), serverNow: h.now};
    },
    snapshot: async state => {
      h.calls.push({operation: "snapshot", id: state.accountId});
      if (h.failed.has(state.accountId) || h.failedSnapshots.has(state.accountId)) throw new Error("Offline");
      return {frame: {event: "unifiedSnapshot", positions: h.positions[state.accountId] ?? []}, serverNow: h.now};
    },
    setLock: async (id, lock) => {
      const record = h.saved.accounts.find(item => item.state.accountId === id);
      assert.equal(record.state.lock.end, lock.end, "each account's deadline is durable before PUT");
      h.puts.push({id, ...structuredClone(lock)});
      if (h.failPut) throw new Error("Offline");
      h.remote[id] = {start: lock.start, end: lock.end};
      return {remote: structuredClone(h.remote[id]), serverNow: h.now};
    }
  };
  h.storage = {load: async () => structuredClone(h.saved), save: async ledger => {
    if (h.failSave) throw new Error("Storage unavailable");
    h.saved = structuredClone(ledger);
  }};
  h.make = () => new ProtectionManager({...(configuredAccountId ? {accountId: configuredAccountId} : {}),
    api: h.api, storage: h.storage, monotonic: () => 0,
    guard: async (active, accountId, ruleId) => {
      if (active) h.rules.set(ruleId, {...lockRule(accountId, "extension-id"), id: ruleId});
      else h.rules.delete(ruleId);
    }});
  h.manager = h.make();
  h.record = id => h.saved.accounts.find(item => item.state.accountId === id);
  h.trade = async id => {
    await h.manager.receive({event: "positionUpdates", data: {positions: [position(id, 1)]}}, {accountId: id, readHost: host});
    await h.manager.receive({event: "positionUpdates", data: {positions: [position(id, 0)]}}, {accountId: id, readHost: host});
  };
  return h;
}

test("fresh installs wait for explicit selection across restarts and ignore unsolicited position events", async () => {
  const h = fixture(undefined, null);
  h.api.account = async () => { throw new Error("No account request expected before selection"); };
  assert.equal((await h.manager.maintain({force: true})).status, "unselected");
  await h.manager.receive({event: "unifiedSnapshot", data: {positions: [position("A", 1)]}});
  await h.manager.invalidate("An unsolicited frame could not be read");
  h.manager = h.make();
  const view = await h.manager.maintain({force: true});
  assert.equal(view.accountId, null);
  assert.equal(view.status, "unselected");
  assert.equal(view.canSelect, true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.puts.length, 0);
});

test("selection without imported configuration persists and retains its lock after restart", async () => {
  const h = fixture(undefined, null);
  assert.equal((await h.manager.choices()).length, 3);
  assert.equal(h.manager.view().status, "unselected");
  assert.equal((await h.manager.selectAccount("B")).accountId, "B");
  await h.trade("B");
  const deadline = h.record("B").state.lock.end;
  h.manager = h.make();
  const view = await h.manager.maintain({force: true});
  assert.equal(view.accountId, "B");
  assert.equal(view.status, "locked");
  assert.equal(view.end, deadline);
  assert.equal(h.puts.length, 1);
  assert.equal(h.rules.has(h.record("B").id), true);
});

test("legacy migration preserves the exact existing deadline and restores its rule before network checks", async () => {
  const old = {...stateA(), lock: {start: epoch - 300, end: epoch - 300 + 28800, reason: "trade", confirmed: true}};
  const h = fixture(old, null);
  await h.manager.run(async () => {});
  assert.equal(h.saved.version, 2);
  assert.deepEqual(h.record("A").state.lock, old.lock);
  assert.equal(h.calls.length, 0);
  assert.equal(h.rules.get(1).condition.urlFilter.includes("/A/"), true);
});

test("locked A stays locked while B is protected, including after a worker restart and a short remote replacement", async () => {
  const h = fixture();
  await h.manager.maintain();
  await h.trade("A");
  const deadline = h.record("A").state.lock.end;
  const choices = await h.manager.choices();
  assert.equal(choices.find(a => a.accountId === "A").lockStatus, "locked");
  assert.equal(choices.find(a => a.accountId === "A").selectable, false);
  assert.equal(choices.find(a => a.accountId === "B").selectable, true);
  assert.equal((await h.manager.selectAccount("B")).accountId, "B");
  assert.equal(h.record("A").state.lock.end, deadline);
  assert.equal(h.rules.has(h.record("A").id), true);
  h.manager = h.make();
  h.remote.A.end = epoch + 5;
  const view = await h.manager.maintain({force: true});
  assert.equal(view.accountId, "B");
  assert.equal(h.remote.A.end, deadline);
  assert.equal(view.lockouts.find(lock => lock.accountId === "A").end, deadline);
  assert.equal(h.puts.at(-1).id, "A");
});

test("two completed trades on two selected accounts keep independent deadlines and browser rules", async () => {
  const h = fixture();
  await h.manager.maintain();
  await h.trade("A");
  const endA = h.record("A").state.lock.end;
  h.now += 100;
  await h.manager.selectAccount("B");
  await h.trade("B");
  assert.equal(h.record("A").state.lock.end, endA);
  assert.equal(h.record("B").state.lock.end, endA + 100);
  assert.equal(h.rules.size, 2);
  await h.manager.selectAccount("C");
  h.now = endA;
  const callsBefore = h.calls.length;
  await h.manager.maintain({force: true});
  assert.equal(h.record("A").state.lock, null);
  assert.equal(h.record("B").state.lock.end, endA + 100);
  assert.equal(h.rules.size, 1);
  assert.equal(h.rules.has(h.record("B").id), true);
  assert.equal(h.calls.slice(callsBefore).some(c => c.operation === "snapshot" && c.id === "A"), false,
    "expiry does not re-arm an account that is no longer selected");
  const options = await h.manager.choices();
  assert.equal(options.find(a => a.accountId === "A").selectable, true);
  assert.equal(options.find(a => a.accountId === "B").selectable, false);
});

test("switching away from a pending lock retains its retry and original deadline", async () => {
  const h = fixture();
  await h.manager.maintain();
  h.failPut = true;
  await h.trade("A");
  const end = h.record("A").state.lock.end;
  await h.manager.selectAccount("B");
  assert.equal(h.manager.accountId, "B");
  assert.equal(h.manager.view().status, "error", "unconfirmed older protection remains visible");
  h.failPut = false;
  await h.manager.maintain({force: true});
  assert.equal(h.remote.A.end, end);
  assert.equal(h.manager.view().status, "ready");
});

test("locked, newly locked, restricted, scheduled, and unknown target accounts are never treated as selectable", async () => {
  for (const condition of ["locked", "restricted", "scheduled", "unknown"]) {
    const h = fixture();
    await h.manager.maintain();
    if (condition === "locked") h.remote.B = {start: epoch - 5, end: epoch + 28800};
    if (condition === "scheduled") h.remote.B = {start: epoch + 100, end: epoch + 28800};
    if (condition === "restricted") h.accounts[1].restricted = true;
    if (condition === "unknown") h.failed.add("B");
    assert.equal((await h.manager.choices()).find(account => account.accountId === "B").selectable, false);
    assert.ok((await h.manager.selectAccount("B")).selectionError);
    assert.equal(h.manager.accountId, "A");
  }
  const h = fixture();
  assert.equal((await h.manager.choices()).find(a => a.accountId === "B").selectable, true);
  h.remote.B = {start: epoch, end: epoch + 28800};
  assert.ok((await h.manager.selectAccount("B")).selectionError, "action rechecks a stale unlocked option");
  assert.equal(h.record("B").state.lock.end, epoch + 28800);
});

test("open positions prevent switching, including a position found during the final account check", async () => {
  for (const observed of [true, false]) {
    const h = fixture();
    await h.manager.maintain();
    if (observed) await h.manager.receive({event: "positionUpdates", data: {positions: [position("A", 1)]}});
    else h.positions.A = [position("A", 1)];
    assert.ok((await h.manager.selectAccount("B")).selectionError);
    assert.equal(h.manager.accountId, "A");
    assert.equal(h.manager.view().canSelect, false);
  }
});

test("a failed durable save cannot discard a locked account during selection", async () => {
  const h = fixture();
  await h.manager.maintain();
  await h.trade("A");
  const saved = structuredClone(h.saved);
  h.failSave = true;
  assert.ok((await h.manager.selectAccount("B")).selectionError);
  assert.deepEqual(h.saved, saved);
  assert.equal(h.manager.accountId, "A");
});

test("one account going offline cannot erase its deadline or stop checks on the selected account", async () => {
  const h = fixture();
  await h.manager.maintain();
  await h.trade("A");
  await h.manager.selectAccount("B");
  h.failed.add("A");
  const before = h.calls.length;
  await h.manager.maintain({force: true});
  assert.ok(h.calls.slice(before).some(c => c.id === "B"));
  assert.equal(h.record("A").state.lock.end, epoch + 28800);
  assert.equal(h.manager.view().status, "error");
  assert.equal(h.manager.view().canSelect, true);
});

test("refreshed IDs keep the same account record and rule without touching another account's lock", async () => {
  const h = fixture();
  await h.manager.maintain();
  await h.trade("A");
  await h.manager.selectAccount("B");
  await h.trade("B");
  const idA = h.record("A").id;
  const idB = h.record("B").id;
  h.accounts[0].accountId = "A-new";
  h.remote["A-new"] = h.remote.A;
  await h.manager.choices();
  assert.equal(h.record("A-new").id, idA);
  assert.equal(h.rules.get(idA).condition.urlFilter.includes("/A-new/"), true);
  assert.equal(h.rules.get(idB).condition.urlFilter.includes("/B/"), true);
  assert.equal(h.record("A-new").state.lock.end, epoch + 28800);
});

test("corrupt ledgers fail without replacing saved restrictions", async () => {
  const good = {version: 2, active: 1, accounts: [{id: 1, state: stateA()}]};
  assert.equal(validateLedger(good), good);
  for (const bad of [{...good, active: 2}, {...good, accounts: []},
    {...good, accounts: [good.accounts[0], good.accounts[0]]},
    {...good, accounts: [{id: 1, state: {...stateA(), lock: {start: epoch, end: epoch + 5, confirmed: true, reason: "trade"}}}]}]) {
    const h = fixture(bad);
    await assert.rejects(() => h.manager.maintain());
    assert.deepEqual(h.saved, bad);
    assert.equal(h.calls.length, 0);
  }
});

test("an unavailable imported hint can be replaced explicitly and the chosen account survives restart", async () => {
  const h = fixture();
  h.accounts = h.accounts.filter(account => account.accountId !== "A");
  assert.equal((await h.manager.maintain()).status, "error");
  assert.equal((await h.manager.selectAccount("B")).accountId, "B");
  assert.equal(h.puts.length, 0);
  h.manager = h.make();
  assert.equal((await h.manager.maintain()).accountId, "B");
});

test("a target snapshot failure retains the old selection and its healthy status", async () => {
  const h = fixture();
  await h.manager.maintain();
  h.failedSnapshots.add("B");
  const result = await h.manager.selectAccount("B");
  assert.equal(result.selectionError, "Offline");
  assert.equal(result.accountId, "A");
  assert.equal(result.status, "ready");
  assert.equal(h.record("A").state.error, null);
});

test("an old account's queued empty snapshot cannot close a newly selected account's position", async () => {
  const h = fixture();
  await h.manager.maintain();
  h.positions.B = [position("B", 1)];
  await Promise.all([
    h.manager.selectAccount("B"),
    h.manager.receive({event: "unifiedSnapshot", data: {positions: []}}, {accountId: "A", readHost: host})
  ]);
  assert.equal(h.manager.accountId, "B");
  assert.equal(h.record("B").state.hasOpen, true);
  assert.equal(h.record("B").state.lock, null);
  assert.equal(h.puts.length, 0);
});

test("slow account-status lookups cannot delay a trade lock or apply stale data over its confirmation", {timeout: 2000}, async () => {
  const h = fixture();
  await h.manager.maintain();
  const getLock = h.api.getLock;
  let release;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  h.api.getLock = async id => {
    if (id === "B") { began(); await new Promise(resolve => { release = resolve; }); }
    return getLock(id);
  };
  const listing = h.manager.choices();
  await started;
  await h.trade("A");
  assert.equal(h.puts.length, 1);
  release();
  const choices = await listing;
  assert.equal(choices.find(account => account.accountId === "A").lockStatus, "locked");
  assert.equal(h.record("A").state.lock.confirmed, true);
});

test("a freshly verified broker-locked account can be left even if its position API is unavailable", async () => {
  const h = fixture();
  await h.manager.maintain();
  h.accounts[0].restricted = true;
  h.failedSnapshots.add("A");
  const result = await h.manager.selectAccount("B");
  assert.equal(result.selectionError, undefined);
  assert.equal(result.accountId, "B");
  assert.equal((await h.manager.choices()).find(account => account.accountId === "A").lockStatus, "locked");
});
