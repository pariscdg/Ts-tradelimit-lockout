import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";

const url = "https://prod-trade-write.tradesea.ai/v1/internal/accounts/riskSettings/enabled";
async function fixture() {
  const sent = [];
  const handlers = {};
  class XHR {
    open(method, address) { this.address = address; }
    send(body) { sent.push({url: this.address, body}); }
  }
  const window = {XMLHttpRequest: XHR, addEventListener: (name, handler) => { handlers[name] = handler; },
    fetch: async function (address, options) { assert.equal(this, window); sent.push({url: address, body: options?.body}); return "ok"; }};
  const context = vm.createContext({window, location: {href: "https://app.tradesea.ai/trade", origin: "https://app.tradesea.ai"}, URL, Request, DOMException});
  vm.runInContext(await readFile(new URL("../extension/risk-network.js", import.meta.url), "utf8"), context);
  const policy = ids => handlers.message({source: window, origin: "https://app.tradesea.ai", data: {channel: "tradesea-one-trade-v2", kind: "risk-policy", accountIds: ids}});
  policy(["A"]);
  return {window, policy, sent};
}

test("batch fetch blocks edits touching a risk-locked account without affecting other accounts or orders", async () => {
  const h = await fixture();
  await assert.rejects(h.window.fetch(url, {method: "PATCH", body: JSON.stringify({disable_account_ids: ["A"]})}), /risk settings are locked/);
  await assert.rejects(h.window.fetch(url, {method: "PATCH", body: JSON.stringify({enable_account_ids: ["B", "A"]})}), /risk settings are locked/);
  assert.equal(h.sent.length, 0);
  await h.window.fetch(url, {method: "PATCH", body: JSON.stringify({disable_account_ids: ["B"]})});
  await h.window.fetch("https://prod-trade-write.tradesea.ai/v1/orders", {method: "POST", body: JSON.stringify({accountId: "A"})});
  await h.window.fetch(url, {method: "GET"});
  assert.equal(h.sent.length, 3);
  h.policy([]);
  await h.window.fetch(url, {method: "PATCH", body: JSON.stringify({disable_account_ids: ["A"]})});
  assert.equal(h.sent.length, 4);
});

test("XHR and Request bodies cannot clear a locked account through the batch route", async () => {
  const h = await fixture();
  const request = new Request(url, {method: "PATCH", body: JSON.stringify({disable_account_ids: ["A"]})});
  await assert.rejects(h.window.fetch(request), /risk settings are locked/);
  assert.equal(request.bodyUsed, false);
  const xhr = new h.window.XMLHttpRequest();
  xhr.open("PATCH", url);
  assert.throws(() => xhr.send(JSON.stringify({disable_account_ids: ["A"]})), /risk settings are locked/);
  assert.throws(() => xhr.send("unrecognized payload"), /risk settings are locked/);
  assert.throws(() => xhr.send(new Blob(["payload"])), /risk settings are locked/);
  xhr.send(JSON.stringify({disable_account_ids: ["B"]}));
  assert.equal(h.sent.length, 1);
});
