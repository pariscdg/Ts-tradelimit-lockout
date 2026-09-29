import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

test("risk selection reads the current tab directly without waiting for the page observer", async () => {
  let handler;
  let selected = "A";
  let denied = false;
  const reads = [];
  const updates = [];
  const window = {postMessage() {}, addEventListener() {}, sessionStorage: {getItem(key) {
    reads.push(key);
    if (denied) throw new Error("Storage unavailable");
    return selected;
  }}};
  const context = vm.createContext({window, location: {origin: "https://app.tradesea.ai"},
    chrome: {runtime: {onMessage: {addListener: fn => {handler = fn;}}, sendMessage: async () => ({})}},
    tradeSeaRiskPanel: {update: (policy, account) => updates.push(account)}, setInterval() {}, setTimeout() {},
    document: {documentElement: null}});
  vm.runInContext(await readFile(new URL("../extension/bridge.js", import.meta.url), "utf8"), context);
  const probe = () => { let reply; handler({type: "selection-probe"}, {}, result => { reply = result; }); return reply; };
  assert.equal(probe().accountId, "A", "the response is immediate even with no MAIN-world listener");
  selected = "B";
  assert.equal(probe().accountId, "B", "the current tab selection wins over cached state");
  assert.deepEqual(updates, ["A", "B"]);
  denied = true;
  assert.equal(probe().accountId, null, "an unreadable selector cannot fall back to an old account");
  assert.ok(reads.every(key => key === "profit_selected_account"), "no cookies, tokens, or other storage keys are read");
});
