import test from "node:test";
import assert from "node:assert/strict";

test("only a popup targeting the freshly selected account can start a risk lock, with no risk-setting writes", async () => {
  const hooks = {};
  const listener = name => ({addListener: fn => { hooks[name] = fn; }});
  const stored = {};
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const popup = {id: extensionId, url: `chrome-extension://${extensionId}/popup.html`};
  const page = {id: extensionId, tab: {id: 42}, frameId: 0, url: "https://app.tradesea.ai/trade"};
  let selected = "A";
  let now = 1800000000;
  const methods = [];
  const reloaded = [];
  const installed = new Map([[1, {id: 1, action: {type: "block"}, condition: {urlFilter: "one-trade-test"}}]]);
  globalThis.chrome = {
    runtime: {id: extensionId, getURL: path => `chrome-extension://${extensionId}/${path}`,
      onMessage: listener("message"), onInstalled: listener("installed"), onStartup: listener("startup")},
    storage: {local: {setAccessLevel: async () => {}, get: async key => ({[key]: structuredClone(stored[key])}),
      set: async value => Object.assign(stored, structuredClone(value))}},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {}},
    tabs: {query: async () => [{id: 42, url: page.url}], reload: async id => reloaded.push(id),
      sendMessage: async (id, message) => message.type === "selection-probe" ? {accountId: selected} : undefined,
      onRemoved: listener("removed"), onUpdated: listener("updated")},
    alarms: {get: async () => ({}), create: async () => {}, onAlarm: listener("alarm")},
    declarativeNetRequest: {getDynamicRules: async () => [...installed.values()], updateDynamicRules: async ({removeRuleIds, addRules}) => {
      removeRuleIds.forEach(id => installed.delete(id));
      addRules.forEach(rule => installed.set(rule.id, rule));
    }}
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    methods.push(options.method);
    let body;
    if (url.endsWith("/accountsWithDetails")) body = {s: "success", d: ["A", "B"].map(id => ({id, name: `Account ${id}`, externalAccountId: `external-${id}`}))};
    else if (url.endsWith("/risk-limits")) body = {status: "success", data: {riskLimits: {personalDailyLossLimit: 600, personalDailyAction: "liquidateAndBlock"}}};
    else throw new Error(`Unexpected URL: ${url}`);
    return new Response(JSON.stringify(body), {headers: {Date: new Date(now * 1000).toUTCString()}});
  };
  try {
    await import(`../extension/background.mjs?risk=${Date.now()}`);
    const send = (message, sender = popup) => new Promise(resolve => hooks.message(message, sender, resolve));
    const enable = {type: "setRiskLock", accountId: "A", tabId: 42, enabled: true, seconds: 5};
    selected = null;
    const disconnected = await send({type: "riskSelection"});
    assert.equal(disconnected.riskSelection, null);
    assert.match(disconnected.riskSelectionError, /Reconnect TradeSea/);
    await send({type: "reconnectRiskTab"}, page);
    assert.deepEqual(reloaded, [], "page messages cannot reload the tab");
    assert.equal((await send({type: "reconnectRiskTab"})).reconnecting, true);
    assert.deepEqual(reloaded, [42]);
    selected = "A";
    const selection = await send({type: "riskSelection"});
    assert.equal(selection.riskSelection.accountId, "A", "risk selection works independently of position or one-trade lockout lookups");
    selected = "B";
    assert.match((await send(enable)).riskError, /account changed/);
    assert.equal(stored.riskSettingsLocks, undefined);
    selected = "A";
    await send(enable, page);
    assert.equal(stored.riskSettingsLocks, undefined, "page messages cannot start or cancel this setting");
    const locked = await send(enable);
    assert.equal(locked.riskSettings.locks.length, 1);
    assert.equal(locked.riskSettings.locks[0].end, null, "an injected duration is ignored");
    assert.equal(locked.riskSettings.locks[0].permanent, true);
    assert.equal(installed.size, 3);
    assert.equal(installed.has(1), true, "one-trade rules are untouched");
    assert.match((await send({...enable, enabled: false})).riskError, /cannot be unlocked/);
    const savedLedger = structuredClone(stored.riskSettingsLocks);
    delete stored.riskSettingsLocks;
    await import(`../extension/background.mjs?risk-missing=${Date.now()}`);
    const missing = await send({type: "status"});
    assert.match(missing.riskSettings.error, /records are missing/);
    assert.equal(installed.size, 3, "missing storage must not remove an existing browser restriction");
    stored.riskSettingsLocks = savedLedger;
    await import(`../extension/background.mjs?risk-restart=${Date.now()}`);
    const restored = await send({type: "status"});
    assert.equal(restored.riskSettings.locks[0].permanent, true);
    now += 10 * 365 * 86400;
    // A selected-account change forces a fresh account lookup years later.
    await send({type: "observe", event: {kind: "selectedAccount", accountId: "A"}}, page);
    const retained = await send({type: "status"});
    assert.equal(retained.riskSettings.locks.length, 1);
    assert.equal(retained.riskSettings.locks[0].end, null);
    assert.match((await send({...enable, enabled: false})).riskError, /permanently locked/);
    assert.equal(installed.size, 3);
    assert.equal(installed.has(1), true);
    assert.ok(methods.every(method => method === "GET"), "locking the UI never changes limits or trades");
  } finally { globalThis.fetch = originalFetch; delete globalThis.chrome; }
});
