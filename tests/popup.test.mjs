import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

// Exercise the shipped popup with a minimal DOM. No Chrome session or API is used.
test("the popup disables only the timed locked row and removes its label after refresh", async () => {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.textContent = ""; this.value = ""; this.events = {}; }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    addEventListener(name, callback) { this.events[name] = callback; }
    get options() { return this.children; }
    get selectedOptions() { return this.children.filter(child => child.value === this.value); }
  }
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const end = 1800036000;
  let accounts = [
    {accountId: "A", accountName: "Demo Account", externalAccountId: "fake-demo", selectable: true, lockStatus: "available", end: null},
    {accountId: "B", accountName: "Firm Account", externalAccountId: "fake-firm", selectable: false, lockStatus: "locked", end}
  ];
  let view = {status: "ready", message: "Monitoring", accountId: "A", accountName: "Demo Account", canSelect: true,
    lockouts: [{accountId: "B", accountName: "Firm Account", end, selected: false}]};
  const intervals = [];
  const context = vm.createContext({document: {getElementById: element, createElement: () => new Element()},
    chrome: {runtime: {sendMessage: async message => message.type === "selection"
      ? {accounts: structuredClone(accounts), view: structuredClone(view), selectedAccountId: "A"} : structuredClone(view)}},
    setInterval: (callback, ms) => intervals.push({callback, ms}), Date});
  vm.runInContext(await readFile(new URL("../extension/popup.js", import.meta.url), "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  const options = element("account-choice").options;
  assert.equal(options.find(option => option.value === "A").disabled, false);
  assert.doesNotMatch(options.find(option => option.value === "A").textContent, /Locked|pending|confirmation/i);
  assert.equal(options.find(option => option.value === "B").disabled, true);
  assert.match(options.find(option => option.value === "B").textContent, /Firm Account · Locked until/);
  assert.doesNotMatch(options.find(option => option.value === "B").textContent, /fake-firm|confirmation/i);
  assert.equal(element("protect-account").disabled, false);
  assert.equal(element("other-lockouts-list").children.length, 1);
  accounts[1] = {...accounts[1], end: null, lockStatus: "available", selectable: true};
  view = {...view, lockouts: []};
  await intervals.find(timer => timer.ms === 15000).callback();
  const refreshed = element("account-choice").options.find(option => option.value === "B");
  assert.equal(refreshed.disabled, false);
  assert.equal(refreshed.textContent, "Firm Account");
  assert.equal(element("other-lockouts").hidden, true);
});
