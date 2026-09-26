import {TradeSeaApi} from "./api.mjs";
import {ProtectionManager} from "./manager.mjs";
import {lockRule, streamInfo, validId} from "./core.mjs";

const streams = new Map();
const tabs = new Set();
const selectedByTab = new Map();
let currentView = {status: "starting", message: "Open TradeSea in your regular Chrome profile to check protection."};
let enginePromise;
const primaryStreams = new Map();
const streamAccount = stream => JSON.stringify([stream.readHost, stream.accountId]);
const guardInstalled = new Map();
const connected = (accountId, readHost) => [...streams.values()].some(s => s.connected && s.accountId === accountId && s.readHost === readHost);

async function publish(view) {
  currentView = view;
  if (view.automatic?.enabled) {
    const accounts = view.automatic.accounts.map(account => account.status === "ready" && !connected(account.accountId, account.readHost)
      ? {...account, status: "disconnected", message: "Open this account in a TradeSea tab for live monitoring."} : account);
    currentView = {...view, automatic: {...view.automatic, accounts}};
    const waiting = accounts.filter(account => account.status === "disconnected");
    if (waiting.length && view.status === "ready") currentView = {...currentView, status: "disconnected",
      message: `Waiting for live monitoring: ${waiting.map(account => account.accountName).join(", ")}. Keep a TradeSea tab open for each account you trade.`};
  } else if (view.status === "ready" && !connected(view.accountId, view.readHost)) currentView = {...view, status: "disconnected",
    message: "Select this protected account in TradeSea and refresh that tab to connect live monitoring."};
  const text = {error: "!", disconnected: "!", locked: "Lock", starting: "…", unselected: "…"}[currentView.status] ?? "";
  await chrome.action.setBadgeText({text});
  await chrome.action.setBadgeBackgroundColor({color: ["error", "disconnected"].includes(currentView.status) ? "#a15c0b" : "#205b4a"});
  await chrome.action.setTitle({title: `TradeSea One Trade — ${currentView.message}`});
  for (const tabId of tabs) {
    try { await chrome.tabs.sendMessage(tabId, {type: "status", view: currentView}); }
    catch { tabs.delete(tabId); }
  }
}

function engine() {
  if (!enginePromise) enginePromise = (async () => {
    await chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"});
    return new ProtectionManager({api: new TradeSeaApi(), publish,
      storage: {
        load: async () => {
          const ledger = (await chrome.storage.local.get("protectionLedger")).protectionLedger;
          return ledger === undefined ? (await chrome.storage.local.get("protection")).protection : ledger;
        },
        save: async ledger => chrome.storage.local.set({protectionLedger: ledger,
          protection: ledger.accounts.find(record => record.id === ledger.active).state})
      },
      guard: async (active, requestAccountId, ruleId) => {
        const guardKey = active ? requestAccountId : "off";
        if (guardInstalled.get(ruleId) === guardKey) return;
        await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds: [ruleId],
          addRules: active ? [{...lockRule(requestAccountId, chrome.runtime.id), id: ruleId}] : []});
        guardInstalled.set(ruleId, guardKey);
      }
    });
  })();
  return enginePromise;
}

async function maintain(force = false) {
  try {
    const protector = await engine();
    await protector.maintain({force, connected});
  } catch (error) { await publish({status: "error", message: error.message}); }
  return currentView;
}

function isTradeSea(sender) {
  try { return sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0 &&
    !sender.tab.incognito && new URL(sender.url).origin === "https://app.tradesea.ai"; }
  catch { return false; }
}

async function handle(message, sender) {
  if (sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html") && !sender.tab) {
    if (message?.type === "status") return currentView;
    if (message?.type === "selection") {
      const protector = await engine();
      const accounts = await protector.choices();
      const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
      return {accounts, view: currentView, selectedAccountId: selectedByTab.get(activeTab?.id) ?? null};
    }
    if (message?.type === "selectAccount" && validId(message.accountId)) {
      const protector = await engine();
      const result = await protector.selectAccount(message.accountId);
      // A previous primary stream may belong to the old protected account.
      primaryStreams.clear();
      return result.selectionError ? {...currentView, selectionError: result.selectionError} : currentView;
    }
    if (["setAutomaticEnabled", "setAutomaticAccount"].includes(message?.type)) {
      const protector = await engine();
      try {
        if (message.type === "setAutomaticEnabled") await protector.setAutomaticEnabled(message.enabled);
        else await protector.setAutomaticAccount(message.accountId, message.checked);
        return await maintain(true);
      } catch (error) {
        // Preference failures do not overwrite healthy account protection.
        await publish(protector.view());
        return {...currentView, preferenceError: error.message};
      }
    }
    throw new Error("Unsupported popup request.");
  }
  if (!isTradeSea(sender)) throw new Error("Unsupported message source.");
  tabs.add(sender.tab.id);
  if (message.type === "heartbeat") {
    if (!message.alive) {
      await publish({status: "error", message: "Position monitoring has not attached. Reload the TradeSea tab before trading."});
      return currentView;
    }
    return maintain();
  }
  if (message.type !== "observe") throw new Error("Unsupported request.");
  const event = message.event;
  if (event?.kind === "selectedAccount") {
    if (validId(event.accountId)) selectedByTab.set(sender.tab.id, event.accountId);
    else selectedByTab.delete(sender.tab.id);
    return currentView;
  }
  if (event?.kind === "fault") {
    const protector = await engine();
    await protector.invalidate("A TradeSea position message could not be read. Check protection before trading.");
    return currentView;
  }
  if (!validId(event?.streamId)) return currentView;
  const key = `${sender.tab.id}:${sender.documentId}:${event.streamId}`;
  if (event.kind === "connection") {
    const info = streamInfo(event.url);
    if (!info) return currentView;
    streams.set(key, {tabId: sender.tab.id, accountId: info.accountId, readHost: info.host, connected: event.connected === true});
    for (const [account, primary] of primaryStreams) if (primary === key && !event.connected) primaryStreams.delete(account);
    // Avoid a network request for each market-data frame.
    return currentView;
  }
  if (event.kind === "frame" && streams.has(key)) {
    const protector = await engine();
    // One source per account prevents duplicate tabs from replaying snapshots.
    // The manager routes each frame only to its enrolled, monitored identity.
    const account = streamAccount(streams.get(key));
    if (!primaryStreams.has(account)) primaryStreams.set(account, key);
    if (primaryStreams.get(account) !== key) return currentView;
    await protector.receive(event.frame, streams.get(key));
  }
  return currentView;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(reply).catch(async error => {
    await publish({status: "error", message: error.message});
    reply(currentView);
  });
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  tabs.delete(tabId);
  selectedByTab.delete(tabId);
  for (const [key, value] of streams) if (value.tabId === tabId) {
    streams.delete(key);
    for (const [account, primary] of primaryStreams) if (primary === key) primaryStreams.delete(account);
  }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "loading") return;
  selectedByTab.delete(tabId);
  for (const [key, value] of streams) if (value.tabId === tabId) {
    streams.delete(key);
    for (const [account, primary] of primaryStreams) if (primary === key) primaryStreams.delete(account);
  }
});
async function start() {
  await chrome.alarms.create("protection-check", {periodInMinutes: 0.5});
  return maintain(true);
}
chrome.runtime.onInstalled.addListener(() => { void start(); });
chrome.runtime.onStartup.addListener(() => { void start(); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "protection-check") void maintain(true);
});
// Alarm definitions may disappear on browser restart; ensure one on each wake.
void chrome.alarms.get("protection-check").then(alarm => {
  if (!alarm) return chrome.alarms.create("protection-check", {periodInMinutes: 0.5});
}).catch(() => publish({status: "error", message: "Background protection checks could not start."}));
