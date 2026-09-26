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

test("popup checkboxes save multiple accounts immediately and its toggle reflects persisted settings", async () => {
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
  const accounts = ["A", "B", "C"].map(accountId => ({accountId, accountName: `Account ${accountId}`, selectable: true, lockStatus: "available"}));
  const sent = [];
  const automatic = {enabled: false, accounts: []};
  let lockouts = [];
  const view = () => ({status: "ready", message: "Monitoring", canSelect: !automatic.enabled, openQuantity: 0,
    accountId: "A", accountName: "Account A", lockouts, automatic: structuredClone(automatic)});
  let failPreference = false;
  const intervals = [];
  const context = vm.createContext({document: {getElementById: element, createElement: () => new Element()},
    chrome: {runtime: {sendMessage: async message => {
      sent.push(message);
      if (message.type === "selection") return {accounts: structuredClone(accounts), view: view()};
      if (failPreference) return {...view(), preferenceError: "Could not save this setting."};
      if (message.type === "setAutomaticAccount") {
        automatic.accounts = message.checked ? [...automatic.accounts, {...accounts.find(a => a.accountId === message.accountId), status: "ready", openQuantity: 0}]
          : automatic.accounts.filter(a => a.accountId !== message.accountId);
      }
      if (message.type === "setAutomaticEnabled") automatic.enabled = message.enabled;
      return view();
    }}}, setInterval: (callback, ms) => intervals.push({callback, ms}), Date});
  vm.runInContext(await readFile(new URL("../extension/popup.js", import.meta.url), "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  const row = index => element("automatic-accounts").children[index].children[0];
  assert.equal(element("automatic-enabled").disabled, true);
  for (const index of [0, 1]) {
    const checkbox = row(index);
    checkbox.checked = true;
    await checkbox.events.change();
  }
  assert.deepEqual(automatic.accounts.map(a => a.accountId), ["A", "B"]);
  assert.equal(element("automatic-enabled").disabled, false);
  element("automatic-enabled").checked = true;
  await element("automatic-enabled").events.change();
  assert.equal(automatic.enabled, true);
  assert.equal(element("protect-account").disabled, true);
  assert.equal(sent.some(message => message.type === "selectAccount"), false);
  lockouts = [{accountId: "A", accountName: "Account A", end: 1800036000}];
  automatic.accounts[0].status = "locked";
  await intervals.find(timer => timer.ms === 1000).callback();
  assert.equal(row(0).disabled, true);
  assert.equal(row(0).checked, true);
  assert.equal(row(2).disabled, false);
  assert.match(element("automatic-accounts").children[0].children[1].children[0].textContent, /Locked until/);
  failPreference = true;
  element("automatic-enabled").checked = false;
  await element("automatic-enabled").events.change();
  assert.equal(element("automatic-enabled").checked, true, "a failed save restores the persisted toggle state");
  assert.match(element("automatic-message").textContent, /Could not save/);
});
