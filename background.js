/**
 * AutoClick SatuSehat - Service Worker (MV3)
 *
 * Tugas:
 *   - Update badge ekstensi PER-TAB sesuai status domain tab itu
 *     (state diisolasi per-hostname).
 *   - Re-broadcast event ke popup kalau popup sedang terbuka.
 *
 * Storage scheme:
 *   `autoclick_state:<hostname>`  -> state per domain
 *   `autoclick_logs:<hostname>`   -> logs per domain
 */

const STATE_KEY_PREFIX = "autoclick_state:";

const getHostnameFromUrl = (url) => {
  try {
    if (!url) return "";
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname;
  } catch (_) {
    return "";
  }
};

const setBadgeForTab = (tabId, isRunning) => {
  try {
    chrome.action.setBadgeText({
      tabId,
      text: isRunning ? "ON" : "",
    });
    chrome.action.setBadgeBackgroundColor({
      tabId,
      color: isRunning ? "#16a34a" : "#6b7280",
    });
  } catch (_) {}
};

const refreshBadgeForTab = async (tab) => {
  if (!tab || !tab.id) return;
  const hostname = getHostnameFromUrl(tab.url);
  if (!hostname) {
    setBadgeForTab(tab.id, false);
    return;
  }
  const key = STATE_KEY_PREFIX + hostname;
  const data = await chrome.storage.local.get(key);
  const state = data[key];
  setBadgeForTab(tab.id, !!(state && state.isRunning));
};

const refreshBadgesForHostname = async (hostname, isRunning) => {
  if (!hostname) return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (getHostnameFromUrl(tab.url) === hostname) {
        setBadgeForTab(tab.id, isRunning);
      }
    }
  } catch (_) {}
};

chrome.runtime.onInstalled.addListener(async () => {
  try {
    chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
  } catch (_) {}
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    refreshBadgeForTab(tab);
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    refreshBadgeForTab(tab);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of Object.keys(changes)) {
    if (!key.startsWith(STATE_KEY_PREFIX)) continue;
    const hostname = key.slice(STATE_KEY_PREFIX.length);
    const next = changes[key].newValue;
    refreshBadgesForHostname(hostname, !!(next && next.isRunning));
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "LOG" || msg.type === "FINISHED") {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {}
  }

  if (msg.type === "TRIGGER_ACTIVE_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs[0];
      if (!tab) {
        sendResponse({ ok: false, error: "Tidak ada tab aktif" });
        return;
      }
      chrome.tabs
        .sendMessage(tab.id, { type: "TRIGGER_RUN" })
        .then((res) => sendResponse({ ok: true, res }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    });
    return true;
  }

  return false;
});
