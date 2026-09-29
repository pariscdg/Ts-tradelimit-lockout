import test from "node:test";
import assert from "node:assert/strict";
import {RiskSettingsLock, riskRules, validateRiskLedger, isRiskRule} from "../extension/risk-lock.mjs";

const epoch = Date.parse("2026-09-28T16:00:00Z") / 1000;
const deadline = Date.parse("2026-09-28T21:00:00Z") / 1000;
const host = "prod-trade-read.tradesea.ai";
function fixture() {
  const h = {saved: undefined, time: epoch, tick: 0, rules: [], calls: [], offline: false, failSave: false, failRules: false,
    accounts: ["A", "B"].map(id => ({accountId: id, externalAccountId: `external-${id}`, accountName: `Lucid ${id}`, readHost: host}))};
  const accounts = () => {
    if (h.offline) throw new Error("Offline");
    return h.accounts.map(account => ({...account, serverNow: h.time}));
  };
  h.make = () => new RiskSettingsLock({monotonic: () => h.tick, api: {
    accounts: async () => { h.calls.push("accounts"); return accounts(); },
    account: async id => {
      const account = accounts().find(account => account.accountId === id);
      if (!account) throw new Error("Account unavailable");
      return account;
    },
    riskSettings: async () => { h.calls.push("risk GET"); return {serverNow: h.time}; }
  }, storage: {load: async () => structuredClone(h.saved), save: async ledger => {
    if (h.failSave) throw new Error("Storage failed");
    h.saved = structuredClone(ledger);
  }}, rules: async rules => {
    if (h.failRules) throw new Error("Rules failed");
    if (rules.length) assert.ok(h.saved?.locks.length, "the lock is saved before its rules are installed");
    h.rules = structuredClone(rules);
  }});
  h.lock = h.make();
  return h;
}

test("risk lock permanently freezes only the selected account without changing saved limits", async () => {
  const h = fixture();
  const view = await h.lock.enable("A");
  assert.equal(view.locks.length, 1);
  assert.deepEqual(view.locks[0].accountIds, ["A"]);
  assert.equal(view.locks[0].end, null);
  assert.equal(view.locks[0].permanent, true);
  assert.equal(view.locks[0].secondsRemaining, undefined);
  assert.equal(view.enforced, true);
  assert.equal(h.rules.length, 2);
  assert.deepEqual(h.calls, ["risk GET"]);
  await assert.rejects(h.lock.disable("A"), /cannot be unlocked/);
  assert.equal(h.saved.locks[0].end, null);
  assert.equal(h.saved.version, 2);
});

test("existing daily locks migrate to permanent across winter, summer, and daylight-saving transitions", async () => {
  const cases = [
    ["2026-09-28T20:59:59Z", "2026-09-28T21:00:00Z"],
    ["2026-09-28T21:00:00Z", "2026-09-29T21:00:00Z"],
    ["2026-09-28T23:00:00Z", "2026-09-29T21:00:00Z"],
    ["2026-12-31T22:00:00Z", "2027-01-01T22:00:00Z"],
    ["2026-01-02T16:00:00Z", "2026-01-02T22:00:00Z"],
    ["2026-03-07T22:00:00Z", "2026-03-08T21:00:00Z"],
    ["2026-10-31T21:00:00Z", "2026-11-01T22:00:00Z"]
  ];
  for (const [start, end] of cases) {
    const h = fixture();
    await h.lock.enable("A");
    h.saved.version = 1;
    const lock = h.saved.locks[0];
    delete lock.permanent;
    Object.assign(lock, {start: Date.parse(start) / 1000, end: Date.parse(end) / 1000, schedule: "eastern-1700",
      serverTimeFloor: Date.parse(start) / 1000});
    h.time = Date.parse(end) / 1000 + 86400;
    h.lock = h.make();
    await h.lock.refresh(true);
    assert.equal(h.saved.version, 2);
    assert.equal(h.saved.locks[0].permanent, true, start);
    assert.equal(h.saved.locks[0].end, null);
    assert.equal(h.saved.locks[0].schedule, undefined);
    assert.equal(h.rules.length, 2);
  }
});

test("upgrading a saved 23-hour lock makes it permanent and preserves its identity", async () => {
  const h = fixture();
  await h.lock.enable("A");
  h.saved.version = 1;
  delete h.saved.locks[0].permanent;
  h.saved.locks[0].end = epoch + 82800;
  h.lock = h.make();
  await h.lock.refresh(true);
  await h.lock.enable("A");
  assert.equal(h.saved.locks[0].end, null);
  assert.equal(h.saved.locks[0].permanent, true);
  assert.equal(h.saved.locks[0].externalAccountId, "external-A");
  h.time = epoch + 100 * 86400;
  await h.lock.refresh(true);
  assert.equal(h.saved.locks.length, 1, "the former deadline cannot release a migrated lock");
});

test("failed migration storage retains existing rules and retries before changing them", async () => {
  const h = fixture();
  await h.lock.enable("A");
  h.saved.version = 1;
  delete h.saved.locks[0].permanent;
  Object.assign(h.saved.locks[0], {end: deadline, schedule: "eastern-1700"});
  const rulesBefore = structuredClone(h.rules);
  h.failSave = true;
  h.lock = h.make();
  await assert.rejects(h.lock.refresh(true), /Storage failed/);
  await assert.rejects(h.lock.enable("B"), /Storage failed/);
  assert.equal(h.saved.version, 1);
  assert.equal(h.lock.ledger, null);
  assert.equal(h.lock.view().enforced, false);
  assert.deepEqual(h.rules, rulesBefore);
  h.failSave = false;
  await h.lock.refresh(true);
  assert.equal(h.saved.version, 2);
  assert.equal(h.saved.locks[0].permanent, true);
  assert.deepEqual(h.rules, rulesBefore);
});

test("repeated activation and worker restarts preserve the permanent lock", async () => {
  const h = fixture();
  await h.lock.enable("A");
  const start = h.saved.locks[0].start;
  h.time += 600;
  await h.lock.enable("A");
  h.lock = h.make();
  await h.lock.refresh(true);
  await assert.rejects(h.lock.disable("A"), /permanently locked/);
  assert.equal(h.saved.locks[0].start, start);
  assert.equal(h.saved.locks[0].end, null);
  assert.equal(h.rules.length, 2);
  assert.equal(h.calls.filter(call => call === "risk GET").length, 1);
});

test("re-enabling an existing identity immediately protects its new ID without restarting it", async () => {
  const h = fixture();
  await h.lock.enable("A");
  h.accounts[0].accountId = "refreshed-A";
  h.time += 100 * 86400;
  await h.lock.enable("refreshed-A");
  assert.equal(h.saved.locks.length, 1);
  assert.deepEqual(h.saved.locks[0].accountIds, ["A", "refreshed-A"]);
  assert.equal(h.saved.locks[0].start, epoch);
  assert.equal(h.saved.locks[0].permanent, true);
  assert.equal(h.rules.length, 4);
  assert.equal(h.calls.filter(call => call === "risk GET").length, 1);
  await assert.rejects(h.lock.disable("refreshed-A"), /permanently locked/);
});

test("invalid legacy records cannot clear browser rules during migration", async () => {
  for (const schedule of [undefined, "eastern-1700"]) {
    const h = fixture();
    await h.lock.enable("A");
    h.saved.version = 1;
    delete h.saved.locks[0].permanent;
    Object.assign(h.saved.locks[0], {end: epoch + 5, schedule});
    const before = structuredClone(h.rules);
    h.lock = h.make();
    await assert.rejects(h.lock.refresh(true), /invalid/);
    assert.equal(h.saved.version, 1);
    assert.equal(h.lock.view().enforced, false);
    assert.deepEqual(h.rules, before);
  }
});

test("local time, fresh server time years later, offline checks, and restarts cannot release a risk lock", async () => {
  const h = fixture();
  await h.lock.enable("A");
  h.tick = 90000 * 1000;
  assert.equal(h.lock.view().locks[0].permanent, true);
  await assert.rejects(h.lock.disable("A"), /cannot be unlocked/);
  h.offline = true;
  await assert.rejects(h.lock.refresh(true), /Offline/);
  assert.equal(h.rules.length, 2);
  assert.equal(h.saved.locks.length, 1);
  h.offline = false;
  h.time = epoch + 10 * 365 * 86400;
  h.lock = h.make();
  await h.lock.refresh(true);
  assert.equal(h.rules.length, 2);
  assert.equal(h.saved.locks.length, 1);
  await assert.rejects(h.lock.disable("A"), /cannot be unlocked/);
});

test("an old server clock cannot remove a risk lock after a later verified timestamp", async () => {
  const h = fixture();
  await h.lock.enable("A");
  h.time += 500;
  await h.lock.refresh(true);
  h.time = epoch - 1;
  const view = await h.lock.refresh(true);
  assert.equal(view.locks.length, 1);
  assert.match(view.error, /existing lock remains/);
  assert.equal(h.rules.length, 2);
});

test("risk lock follows a refreshed ID only for the enrolled account and keeps old IDs blocked", async () => {
  const h = fixture();
  await h.lock.enable("A");
  h.accounts[0].accountId = "new-A";
  await h.lock.refresh(true);
  assert.deepEqual(h.saved.locks[0].accountIds, ["A", "new-A"]);
  assert.equal(h.rules.length, 4);
  await assert.rejects(h.lock.disable("new-A"), /cannot be unlocked/);
  h.accounts[0].externalAccountId = "someone-else";
  await h.lock.refresh(true);
  assert.equal(h.saved.locks[0].externalAccountId, "external-A");
  assert.equal(h.rules.length, 4);
});

test("two separately enabled accounts keep permanent locks without enrolling others", async () => {
  const h = fixture();
  await h.lock.enable("A");
  assert.deepEqual(h.saved.locks.map(lock => lock.accountIds[0]), ["A"]);
  h.time = deadline + 1000;
  await h.lock.enable("B");
  await h.lock.refresh(true);
  assert.deepEqual(h.saved.locks.map(lock => lock.accountIds[0]), ["A", "B"]);
  assert.equal(h.rules.length, 4);
  for (const id of ["A", "B"]) await assert.rejects(h.lock.disable(id), /permanently locked/);
});

test("failed storage never claims protection, and a failed rule install retains the permanent lock for recovery", async () => {
  const h = fixture();
  h.failSave = true;
  await assert.rejects(h.lock.enable("A"), /Storage failed/);
  assert.equal(h.rules.length, 0);
  assert.equal(h.saved, undefined);
  h.failSave = false;
  h.failRules = true;
  await assert.rejects(h.lock.enable("A"), /Rules failed/);
  assert.equal(h.saved.locks[0].permanent, true);
  assert.equal(h.lock.view().enforced, false);
  h.failRules = false;
  h.lock = h.make();
  await h.lock.refresh(true);
  assert.equal(h.rules.length, 2);
  assert.equal(h.saved.locks[0].end, null);
});

test("malformed or shortened saved locks never remove existing browser rules", async () => {
  const h = fixture();
  await h.lock.enable("A");
  h.saved.locks[0].end = epoch + 5;
  assert.throws(() => validateRiskLedger(h.saved), /invalid/);
  h.lock = h.make();
  await assert.rejects(h.lock.refresh(true), /invalid/);
  assert.equal(h.rules.length, 2);
  h.saved.locks[0].end = null;
  h.saved.locks[0].permanent = false;
  h.lock = h.make();
  await assert.rejects(h.lock.refresh(true), /invalid/);
  assert.equal(h.rules.length, 2);
});

test("risk URL rules block only risk writes for that account and leave order/close/lockout URLs alone", async () => {
  const h = fixture();
  await h.lock.enable("A");
  const rules = riskRules(h.saved.locks);
  const matches = (url, method) => rules.some(rule => {
    const prefix = rule.condition.urlFilter.slice(1, -1);
    const rest = url.slice(prefix.length);
    return rule.condition.requestMethods.includes(method.toLowerCase()) && url.startsWith(prefix) && (!rest || /^[^a-z\d_.%-]/i.test(rest));
  });
  assert.equal(matches("https://prod-identity.tradesea.ai/eum/v1/prop-fund/A/risk-limits", "POST"), true);
  assert.equal(matches("https://prod-trade-write.tradesea.ai/v1/internal/accounts/A/riskSettings", "PUT"), true);
  for (const method of ["GET", "HEAD"]) assert.equal(matches("https://prod-identity.tradesea.ai/eum/v1/prop-fund/A/risk-limits", method), false);
  for (const url of ["https://prod-identity.tradesea.ai/eum/v1/prop-fund/B/risk-limits",
    "https://prod-identity.tradesea.ai/eum/v1/prop-fund/A/lockout",
    "https://prod-trade-write.tradesea.ai/v1/internal/accounts/A/orders",
    "https://prod-trade-write.tradesea.ai/v1/internal/accounts/A/positions/close",
    "https://prod-identity.tradesea.ai/eum/v1/prop-fund/A/risk-limits-unrelated"]) assert.equal(matches(url, "POST"), false, url);
  assert.equal(isRiskRule({id: 1}), false);
  assert.ok(rules.every(isRiskRule));
});
