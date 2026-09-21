import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {TradeSeaApi} from "../extension/api.mjs";

const time = 1800000000;
const response = (body, status = 200, date = true) => new Response(JSON.stringify(body), {
  status, headers: {"Content-Type": "application/json", ...(date ? {Date: new Date(time * 1000).toUTCString()} : {})}
});
const lock = {start: time, end: time + 28800};
const lockBody = {status: "success", data: {lockoutStartTimeEpoch: lock.start, lockoutEndTimeEpoch: lock.end}};
const flatDemo = JSON.parse(await readFile(new URL("./fixtures/flat-demo-snapshot.json", import.meta.url), "utf8"));

test("default fetch keeps the worker-global receiver required by Chrome", async () => {
  const originalFetch = globalThis.fetch;
  const receivers = [];
  globalThis.fetch = async function (url, options) {
    receivers.push(this);
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return response(lockBody, options.method === "PUT" ? 201 : 200);
  };
  try {
    const api = new TradeSeaApi();
    const result = await api.setLock("saved-account", lock);
    assert.equal(result.accepted, true);
    assert.equal(receivers.length, 1);
    assert.ok(receivers.every(receiver => receiver === globalThis));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("each lock request uses Chrome's current cookies once without a confirmation GET", async () => {
  const calls = [];
  const api = new TradeSeaApi(async (url, options) => {
    calls.push({url, options});
    return response(lockBody, options.method === "PUT" ? 201 : 200);
  });
  const result = await api.setLock("saved-account", lock);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls.map(c => c.options.method), ["PUT"]);
  for (const {url, options} of calls) {
    assert.equal(url, "https://prod-identity.tradesea.ai/eum/v1/prop-fund/saved-account/lockout");
    assert.equal(options.credentials, "include");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
    assert.ok(options.signal);
  }
  assert.deepEqual(JSON.parse(calls[0].options.body), lockBody.data);
  assert.equal(result.accepted, true);
  assert.equal(result.serverNow, time);
});
test("HTTP success containing application failure is not accepted", async () => {
  const api = new TradeSeaApi(async () => response({status: "error", errmsg: "failed"}));
  await assert.rejects(() => api.setLock("saved-account", lock));
});
test("expired login is surfaced, never saved as a successful lock", async () => {
  const api = new TradeSeaApi(async () => response({}, 401));
  await assert.rejects(() => api.getLock("saved-account"), /Sign in normally/);
});
test("missing server clock cannot be replaced with the computer clock", async () => {
  const api = new TradeSeaApi(async () => response(lockBody, 200, false));
  await assert.rejects(() => api.getLock("saved-account"), /server time/);
});
test("account selection resolves the exact saved internal ID and external position account", async () => {
  const api = new TradeSeaApi(async () => response({s: "ok", d: [
    {id: "demo", externalAccountId: "demo-external"},
    {id: "saved-account", externalAccountId: "firm-external", accountType: "RD", name: "Firm account"}
  ]}));
  const result = await api.account("saved-account");
  assert.equal(result.externalAccountId, "firm-external");
  assert.equal(result.readHost, "api-trades-r-delprod.tradesea.ai");
  await assert.rejects(() => api.account("missing"), /has not switched accounts/);
});
test("account lookup uses the active accountsWithDetails route, not the obsolete TV route", async () => {
  const calls = [];
  const api = new TradeSeaApi(async (url, options) => {
    calls.push({url, options});
    if (url === "https://prod-identity.tradesea.ai/um/tv/v1/accounts") return response({}, 404);
    assert.equal(url, "https://prod-identity.tradesea.ai/eum/v1/accountsWithDetails");
    return response({s: "success", d: [{id: "saved-account", externalAccountId: "firm-external", name: "Firm account"}]});
  });
  const result = await api.account("saved-account");
  assert.equal(result.externalAccountId, "firm-external");
  assert.equal(result.accountName, "Firm account");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.credentials, "include");
});
test("404 diagnostics distinguish account lookup, position snapshot, and lockout operations", async () => {
  const api = new TradeSeaApi(async () => response({}, 404));
  const cases = [
    [() => api.account("saved-account"), "Account lookup"],
    [() => api.snapshot({accountId: "saved-account", readHost: "prod-trade-read.tradesea.ai"}), "Position snapshot"],
    [() => api.getLock("saved-account"), "Lockout check"],
    [() => api.setLock("saved-account", lock), "Lockout request"]
  ];
  for (const [operation, label] of cases) {
    await assert.rejects(operation, error => {
      assert.ok(error.message.startsWith(label));
      assert.match(error.message, /HTTP 404/);
      assert.equal(error.message.includes("saved-account"), false);
      return true;
    });
  }
});
test("snapshot request is read-only and rejects unexpected response shape", async () => {
  const calls = [];
  const api = new TradeSeaApi(async (url, options) => { calls.push({url, options}); return response({positions: []}); });
  const state = {accountId: "saved-account", readHost: "prod-trade-read.tradesea.ai"};
  assert.deepEqual((await api.snapshot(state)).frame, {event: "unifiedSnapshot", positions: []});
  assert.equal(calls[0].options.method, "GET");
  assert.match(calls[0].url, /snapshot\/unified/);
  await assert.rejects(() => api.snapshot({...state, readHost: "evil.example"}));
});

test("account choices expose labels and filter incomplete account records", async () => {
  const api = new TradeSeaApi(async () => response({s: "success", d: [
    {id: "A", externalAccountId: "A-ext", name: "First account"},
    {id: 123, externalAccountId: 456, accountName: "Second account", accountType: "RD"},
    {externalAccountId: "missing-id"}, {id: null, externalAccountId: "null-id"},
    {id: "missing-external"}, {id: "invalid/id", externalAccountId: "invalid"}, null
  ]}));
  const accounts = await api.accounts();
  assert.deepEqual(accounts.map(a => a.accountId), ["A", "123"]);
  assert.equal(accounts[1].externalAccountId, "456");
  assert.equal(accounts[1].accountName, "Second account");
  assert.equal(accounts[1].readHost, "api-trades-r-delprod.tradesea.ai");
});

test("a refreshed opaque ID resolves only the same enrolled external account and environment", async () => {
  const api = new TradeSeaApi(async () => response({s: "success", d: [
    {id: "unrelated", externalAccountId: "other"},
    {id: "fresh", externalAccountId: "protected", name: "My account"},
    {id: "other-host", externalAccountId: "protected", accountType: "RD"}
  ]}));
  const reference = {externalAccountId: "protected", readHost: "prod-trade-read.tradesea.ai"};
  assert.equal((await api.account("expired-id", reference)).accountId, "fresh");
  await assert.rejects(() => api.account("expired-id"), /has not switched accounts/);
  await assert.rejects(() => api.account("unrelated", {...reference, externalAccountId: "missing"}), /has not switched accounts/);
  await assert.rejects(() => api.account("expired-id", {externalAccountId: "protected"}), /ambiguous/);
});

test("demo snapshots may omit positions when the complete account summary identifies the account", async () => {
  for (const body of [flatDemo.data, flatDemo, {...flatDemo.data, positions: null}]) {
    const api = new TradeSeaApi(async () => response(body));
    const result = await api.snapshot({accountId: "A", externalAccountId: "external-A", readHost: "api-trades-r-delprod.tradesea.ai"});
    assert.deepEqual(result.frame, {event: "unifiedSnapshot", positions: []});
  }
});

test("missing positions without matching complete account metadata cannot be treated as flat", async () => {
  const cases = [{}, {positions: null}, {orders: []},
    {...flatDemo.data, userFullStates: {accounts: {"other-account": {balance: 100, realizedPl: 0, commission: 0}}}},
    {...flatDemo.data, positions: {}},
    {...flatDemo.data, userFullStates: {accounts: {"external-A": {balance: 100}}}},
    {status: "error", positions: []}, {s: "error", ...flatDemo.data},
    {event: "positionUpdates", data: flatDemo.data}];
  for (const body of cases) {
    const api = new TradeSeaApi(async () => response(body));
    await assert.rejects(() => api.snapshot({accountId: "A", externalAccountId: "external-A", readHost: "prod-trade-read.tradesea.ai"}));
  }
});
