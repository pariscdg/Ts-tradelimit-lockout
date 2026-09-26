import test from "node:test";
import assert from "node:assert/strict";

test("Chrome routes simultaneous automatic accounts independently and persists the toggle", async () => {
  const hooks = {};
  const listener = name => ({addListener: callback => { hooks[name] = callback; }});
  const stored = {};
  const remote = {};
  const puts = [];
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const host = "prod-trade-read.tradesea.ai";
  let seconds = 1800000000;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = {
    runtime: {id: extensionId, getURL: path => `chrome-extension://${extensionId}/${path}`,
      onMessage: listener("message"), onInstalled: listener("installed"), onStartup: listener("startup")},
    storage: {local: {setAccessLevel: async () => {},
      get: async key => ({[key]: structuredClone(stored[key])}),
      set: async value => Object.assign(stored, structuredClone(value))}},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {}},
    tabs: {sendMessage: async () => {}, query: async () => [{id: 1}], onRemoved: listener("removed"), onUpdated: listener("updated")},
    alarms: {get: async () => ({}), create: async () => {}, onAlarm: listener("alarm")},
    declarativeNetRequest: {updateDynamicRules: async () => {}}
  };
  globalThis.fetch = async (url, options) => {
    let body;
    if (url.endsWith("/accountsWithDetails")) body = {s: "success", d: ["A", "B", "C"].map(id => ({id, externalAccountId: `external-${id}`, name: `Account ${id}`}))};
    else if (url.includes("/snapshot/unified?")) body = {positions: []};
    else if (url.endsWith("/lockout")) {
      const accountId = url.split("/").at(-2);
      if (options.method === "PUT") {
        const lock = JSON.parse(options.body);
        assert.equal(lock.lockoutEndTimeEpoch - lock.lockoutStartTimeEpoch, 28800);
        assert.equal(stored.protectionLedger.accounts.find(record => record.state.accountId === accountId).state.lock.end, lock.lockoutEndTimeEpoch);
        remote[accountId] = lock;
        puts.push(accountId);
        seconds = lock.lockoutStartTimeEpoch + 1;
      }
      body = {status: "success", data: remote[accountId] ?? {}};
    } else throw new Error(`Unexpected URL: ${url}`);
    return new Response(JSON.stringify(body), {headers: {Date: new Date(seconds * 1000).toUTCString()}});
  };
  try {
    await import(`../extension/background.mjs?automatic=${Date.now()}`);
    const popup = {id: extensionId, url: chrome.runtime.getURL("popup.html")};
    const page = tab => ({id: extensionId, tab: {id: tab, incognito: false}, frameId: 0,
      documentId: `document-${tab}`, url: "https://app.tradesea.ai/trade"});
    const send = (message, sender = popup) => new Promise(resolve => hooks.message(message, sender, resolve));
    const observe = (tab, event) => send({type: "observe", event}, page(tab));
    const connection = (tab, id, streamId = id) => observe(tab, {kind: "connection", streamId,
      url: `wss://${host}/v1/users/${id}/ws/unified`, connected: true});
    const frame = (tab, id, qty, streamId = id) => observe(tab, {kind: "frame", streamId,
      frame: {event: "positionUpdates", data: {positions: [{id: "ES", accountId: `external-${id}`, qty}]}}});
    for (const accountId of ["A", "B"]) await send({type: "setAutomaticAccount", accountId, checked: true});
    const enabled = await send({type: "setAutomaticEnabled", enabled: true});
    assert.equal(enabled.automatic.enabled, true);
    assert.equal(enabled.status, "disconnected", "snapshot polling is not claimed to be live monitoring");
    await connection(1, "A");
    await connection(2, "B");
    const monitoring = await send({type: "heartbeat", alive: true}, page(1));
    assert.equal(monitoring.status, "ready");
    await frame(1, "A", 1);
    await frame(2, "B", 1);
    await connection(3, "C");
    await frame(3, "C", 1);
    await frame(3, "C", 0);
    await connection(4, "A", "duplicate-A");
    await observe(4, {kind: "frame", streamId: "duplicate-A", frame: {event: "unifiedSnapshot", data: {positions: []}}});
    assert.equal(puts.length, 0, "unchecked and duplicate connections cannot close a monitored trade");
    await frame(1, "A", 0);
    assert.deepEqual(puts, ["A"]);
    await frame(2, "B", 0);
    assert.deepEqual(puts, ["A", "B"]);
    const saved = structuredClone(stored.protectionLedger.automatic);
    await send({type: "setAutomaticEnabled", enabled: false}, page(1));
    assert.deepEqual(stored.protectionLedger.automatic, saved, "TradeSea page messages cannot change preferences");
    await import(`../extension/background.mjs?automatic-restart=${Date.now()}`);
    const restored = await send({type: "heartbeat", alive: true}, page(1));
    assert.equal(restored.automatic.enabled, true);
    assert.equal(restored.lockouts.length, 2);
    assert.equal(restored.status, "locked");
    await send({type: "setAutomaticEnabled", enabled: false});
    assert.equal(stored.protectionLedger.automatic.enabled, false);
    assert.equal(stored.protectionLedger.automatic.recordIds.length, 2);
    assert.deepEqual(puts, ["A", "B"], "preferences and restart never send replacement lockouts");
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
});
