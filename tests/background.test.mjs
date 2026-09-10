import test from "node:test";
import assert from "node:assert/strict";

// Execute the actual background module against a fake Chrome boundary. Every
// network request is intercepted in memory; unknown endpoints fail the test.
test("Chrome messages, storage, request rules, and API work together without an account connection", async () => {
  const hooks = {};
  const listener = name => ({addListener: fn => { hooks[name] = fn; }});
  const stored = {};
  const calls = [];
  const rules = [];
  let now = 1800000000;
  const remote = {};
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  globalThis.chrome = {
    runtime: {id: extensionId, getURL: path => `chrome-extension://${extensionId}/${path}`,
      onMessage: listener("message"), onInstalled: listener("installed"), onStartup: listener("startup")},
    storage: {local: {
      setAccessLevel: async value => { assert.equal(value.accessLevel, "TRUSTED_CONTEXTS"); },
      get: async key => ({[key]: structuredClone(stored[key])}),
      set: async value => { Object.assign(stored, structuredClone(value)); }
    }},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {}},
    tabs: {sendMessage: async () => {}, query: async () => [{id: 42}], onRemoved: listener("removed"), onUpdated: listener("updated")},
    alarms: {get: async () => ({name: "protection-check"}), create: async () => {}, onAlarm: listener("alarm")},
    declarativeNetRequest: {updateDynamicRules: async rule => { rules.push(rule); }}
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({url, method: options.method ?? "GET"});
    let body;
    if (url === "https://prod-identity.tradesea.ai/eum/v1/accountsWithDetails") body = {
      s: "success", d: [{id: "internal-A", externalAccountId: "external-A", name: "Test account"},
        {id: "internal-B", externalAccountId: "external-B", name: "Second account"}]
    };
    else if (url.includes("/snapshot/unified?")) body = {positions: []};
    else if (["internal-A", "internal-B"].some(id => url === `https://prod-identity.tradesea.ai/eum/v1/prop-fund/${id}/lockout`)) {
      if (options.method === "PUT") {
        const payload = JSON.parse(options.body);
        assert.equal(payload.lockoutEndTimeEpoch - payload.lockoutStartTimeEpoch, 28800);
        assert.equal(stored.protection.lock.end, payload.lockoutEndTimeEpoch);
        const accountId = url.split("/").at(-2);
        const record = stored.protectionLedger.accounts.find(item => item.state.accountId === accountId);
        assert.equal(record.state.lock.end, payload.lockoutEndTimeEpoch);
        remote[accountId] = payload;
        now = payload.lockoutStartTimeEpoch + 1;
      }
      body = {status: "success", data: remote[url.split("/").at(-2)] || {}};
    } else throw new Error(`Unexpected network request: ${url}`);
    return new Response(JSON.stringify(body), {headers: {Date: new Date(now * 1000).toUTCString()}});
  };
  try {
    await import(`../extension/background.mjs?fixture=${Date.now()}`);
    const sender = {id: extensionId, tab: {id: 42, incognito: false}, frameId: 0,
      documentId: "document-A", url: "https://app.tradesea.ai/trade"};
    const send = (message, origin = sender) => new Promise(resolve => hooks.message(message, origin, resolve));
    const observe = event => send({type: "observe", event});
    const popup = {id: extensionId, url: chrome.runtime.getURL("popup.html")};
    const initial = await send({type: "heartbeat", alive: true});
    assert.equal(initial.status, "unselected");
    assert.equal(initial.accountId, null);
    assert.equal(initial.canSelect, true);
    await observe({kind: "fault"});
    assert.equal(calls.length, 0, "fresh installs need no account file or account-specific requests");
    await observe({kind: "selectedAccount", accountId: "internal-B"});
    const selection = await send({type: "selection"}, popup);
    assert.equal(selection.selectedAccountId, "internal-B");
    assert.equal(selection.accounts.length, 2);
    assert.equal(selection.view.accountId, null, "page selection is only a hint");
    assert.equal((await send({type: "selectAccount", accountId: "internal-B"}, popup)).accountId, "internal-B");
    // A new worker loads the confirmed selection from extension storage.
    await import(`../extension/background.mjs?fixture=restart-${Date.now()}`);
    assert.equal((await send({type: "heartbeat", alive: true})).accountId, "internal-B");
    assert.equal((await send({type: "selectAccount", accountId: "internal-A"}, popup)).accountId, "internal-A");
    assert.equal(calls.filter(c => c.method === "PUT").length, 0);
    const url = "wss://prod-trade-read.tradesea.ai/v1/users/internal-A/ws/unified";
    await observe({kind: "connection", streamId: "stream-A", url, connected: true});
    assert.equal((await send({type: "heartbeat", alive: true})).status, "ready");
    const message = qty => ({kind: "frame", streamId: "stream-A", frame: {
      event: "positionUpdates", data: {positions: [{id: "ES", qty, accountId: "external-A"}]}
    }});
    await observe(message(1));
    await observe({kind: "connection", streamId: "stream-B", url: url.replace("internal-A", "internal-B"), connected: true});
    await observe({kind: "frame", streamId: "stream-B", frame: {event: "unifiedSnapshot", data: {positions: []}}});
    assert.equal(stored.protection.hasOpen, true, "another account's empty snapshot must not close this trade");
    assert.equal(calls.filter(c => c.method === "PUT").length, 0);
    assert.equal((await observe(message(0))).status, "locked");
    assert.equal(calls.filter(c => c.method === "PUT").length, 1);
    assert.equal(rules.at(-1).addRules[0].action.type, "block");
    assert.deepEqual(rules.at(-1).addRules[0].condition.excludedInitiatorDomains, [extensionId]);
    const deadline = stored.protection.lock.end;
    await import(`../extension/background.mjs?fixture=locked-restart-${Date.now()}`);
    assert.equal((await send({type: "heartbeat", alive: true})).status, "locked");
    assert.equal(stored.protection.lock.end, deadline, "restart retains the active deadline without a config file");
    assert.equal(calls.filter(c => c.method === "PUT").length, 1);
    const options = await send({type: "selection"}, popup);
    assert.equal(options.accounts.find(account => account.accountId === "internal-A").lockStatus, "locked");
    assert.equal(options.accounts.find(account => account.accountId === "internal-B").selectable, true);
    const switched = await send({type: "selectAccount", accountId: "internal-B"}, popup);
    assert.equal(switched.canSelect, true);
    assert.equal(stored.protection.accountId, "internal-B");
    const savedA = () => stored.protectionLedger.accounts.find(record => record.state.accountId === "internal-A").state;
    assert.equal(savedA().lock.end, deadline);
    const denied = await send({type: "selectAccount", accountId: "internal-A"}, popup);
    assert.match(denied.selectionError, /Locked/);
    await send({type: "selectAccount", accountId: "internal-A"});
    assert.equal(stored.protection.accountId, "internal-B", "a page cannot submit popup account commands");
    await send({type: "unlock", seconds: 5});
    assert.equal(savedA().lock.end, deadline);
    await send({type: "heartbeat", alive: true}, {...sender, url: "https://other.example/"});
    assert.equal(savedA().lock.end, deadline);
    hooks.removed(42);
    const view = await send({type: "status"}, popup);
    assert.ok(view.message);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
});
