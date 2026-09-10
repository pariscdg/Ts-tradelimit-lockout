import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {newState, parseFrame, applyPositions} from "../extension/core.mjs";

const source = await readFile(new URL("../extension/observe.js", import.meta.url), "utf8");
const flatDemo = JSON.parse(await readFile(new URL("./fixtures/flat-demo-snapshot.json", import.meta.url), "utf8"));
const url = "wss://prod-trade-read.tradesea.ai/v1/users/saved-account/ws/unified";
class FakeWorker extends EventTarget {
  constructor(...args) { super(); this.args = args; this.sent = []; }
  postMessage(...args) { this.sent.push(args); }
  terminate() { this.stopped = true; }
  receive(data) { this.dispatchEvent(new MessageEvent("message", {data})); }
}
class FakeSocket extends EventTarget {
  static OPEN = 1;
  constructor(url) { super(); this.url = url; }
  send(data) { this.lastSent = data; }
}
function harness() {
  const messages = [];
  const storageReads = [];
  const window = new EventTarget();
  window.Worker = FakeWorker;
  window.WebSocket = FakeSocket;
  window.postMessage = data => messages.push(data);
  window.sessionStorage = {getItem: key => { storageReads.push(key); return "selected-account"; }};
  vm.runInNewContext(source, {window, location: {origin: "https://app.tradesea.ai"},
    EventTarget, URL, crypto: {randomUUID}, Blob, ArrayBuffer, TextDecoder});
  return {window, messages, storageReads};
}

test("worker protocol is observed without extra connections or changed messages", () => {
  const h = harness();
  const worker = new h.window.Worker("/assets/tradingSocketWorker-test.js", {type: "module"});
  const connect = {type: "connect", payload: {websocketUrl: url}};
  worker.postMessage(connect);
  assert.equal(worker instanceof FakeWorker, true);
  assert.equal(worker.sent.length, 1);
  assert.equal(worker.sent[0][0], connect);
  worker.receive({type: "connected", payload: {reconnect: false}});
  const payload = {event: "positionUpdates", data: JSON.stringify({positions: [{id: "ES", qty: 0, accountId: "firm"}], secret: "not-forwarded"})};
  worker.receive({type: "message", payload});
  const observed = h.messages.find(m => m.kind === "frame");
  assert.equal(observed.frame.data.positions[0].qty, 0);
  assert.equal(observed.frame.data.secret, undefined);
  worker.receive({type: "message", payload: {event: "orderUpdates", data: {orders: [1]}}});
  assert.equal(h.messages.filter(m => m.kind === "frame").length, 1);
  worker.terminate();
  assert.equal(worker.stopped, true);
  assert.equal(h.messages.at(-1).connected, false);
});
test("unrelated workers and off-domain sockets are ignored", () => {
  const h = harness();
  const worker = new h.window.Worker("timer.js");
  worker.postMessage({type: "start", payload: {id: "lockout"}});
  worker.receive({type: "tick", payload: {}});
  const socket = new h.window.WebSocket("wss://other.example/feed");
  socket.dispatchEvent(new MessageEvent("message", {data: "not-json"}));
  assert.equal(h.messages.filter(m => m.kind === "frame").length, 0);
  assert.equal(h.messages.filter(m => m.kind === "connection").length, 0);
});
test("page WebSocket preserves constructor behavior and forwards position snapshots", async () => {
  const h = harness();
  const socket = new h.window.WebSocket(url);
  assert.equal(h.window.WebSocket.OPEN, FakeSocket.OPEN);
  assert.equal(socket instanceof h.window.WebSocket, true);
  socket.send("original tradeSea message");
  assert.equal(socket.lastSent, "original tradeSea message");
  socket.dispatchEvent(new Event("open"));
  socket.dispatchEvent(new MessageEvent("message", {data: JSON.stringify({event: "unifiedSnapshot", data: {positions: []}})}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.messages.find(m => m.kind === "frame").frame.event, "unifiedSnapshot");
});

test("selection hints read only profit_selected_account and refresh on a probe", () => {
  const h = harness();
  assert.deepEqual(h.storageReads, ["profit_selected_account"]);
  assert.equal(h.messages.find(m => m.kind === "selectedAccount").accountId, "selected-account");
  h.window.sessionStorage.getItem = key => { h.storageReads.push(key); return "another-account"; };
  const probe = new Event("message");
  Object.assign(probe, {source: h.window, origin: "https://app.tradesea.ai",
    data: {channel: "tradesea-one-trade-v2", kind: "probe"}});
  h.window.dispatchEvent(probe);
  assert.equal(h.messages.at(-1).accountId, "another-account");
  assert.deepEqual(h.storageReads, ["profit_selected_account", "profit_selected_account"]);
});

test("a flat demo snapshot forwards account coverage without its order history or financial summary", () => {
  const h = harness();
  const worker = new h.window.Worker("/assets/tradingSocketWorker-test.js", {type: "module"});
  worker.postMessage({type: "connect", payload: {websocketUrl: url}});
  worker.receive({type: "message", payload: flatDemo});
  const forwarded = h.messages.find(m => m.kind === "frame").frame;
  assert.deepEqual(Array.from(forwarded.data.snapshotAccountIds), ["external-A"]);
  assert.equal(forwarded.data.positions, undefined);
  assert.equal(forwarded.data.orders, undefined);
  assert.equal(forwarded.data.userFullStates, undefined);
  assert.equal(JSON.stringify(forwarded).includes("10030"), false);
  const state = {...newState("saved-account"), externalAccountId: "external-A"};
  const result = applyPositions(state, parseFrame(forwarded), 1800000000);
  assert.equal(result.state.snapshotReady, true);
  assert.equal(result.triggered, false);
});
