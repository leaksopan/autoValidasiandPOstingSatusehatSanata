/**
 * AutoClick SatuSehat - Service Worker (MV3)
 *
 * Tugas:
 *   - Update badge ekstensi PER-TAB sesuai status domain tab itu.
 *     Badge "ON" kalau MINIMAL satu mode (validasi/kirim) sedang isRunning.
 *   - Re-broadcast event ke popup kalau popup sedang terbuka.
 *
 * Storage scheme:
 *   `autoclick_state:<hostname>:<mode>`  -> state per domain per mode
 *   `autoclick_logs:<hostname>:<mode>`   -> logs per domain per mode
 *   mode = "validasi" | "kirim"
 */

const STATE_KEY_PREFIX = "autoclick_state:";
const MODES = ["validasi", "kirim"];

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

const buildStateKeys = (hostname) => MODES.map((m) => `${STATE_KEY_PREFIX}${hostname}:${m}`);

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
  const keys = buildStateKeys(hostname);
  const data = await chrome.storage.local.get(keys);
  const anyRunning = keys.some((k) => data[k] && data[k].isRunning);
  setBadgeForTab(tab.id, anyRunning);
};

const refreshBadgesForHostname = async (hostname) => {
  if (!hostname) return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (getHostnameFromUrl(tab.url) === hostname) {
        await refreshBadgeForTab(tab);
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
  const hostnamesTouched = new Set();
  for (const key of Object.keys(changes)) {
    if (!key.startsWith(STATE_KEY_PREFIX)) continue;
    const rest = key.slice(STATE_KEY_PREFIX.length);
    const lastColon = rest.lastIndexOf(":");
    const hostname = lastColon >= 0 ? rest.slice(0, lastColon) : rest;
    hostnamesTouched.add(hostname);
  }
  for (const h of hostnamesTouched) {
    refreshBadgesForHostname(h);
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
