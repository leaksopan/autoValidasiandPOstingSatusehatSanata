/**
 * AutoClick SatuSehat - Popup Script
 *
 * MULTI-DOMAIN + DUAL-MODE:
 * Storage key: `autoclick_state:<hostname>:<mode>` dimana mode = "validasi" | "kirim".
 * Tab switcher di atas popup memilih mode aktif. Switching tab cuma reload UI,
 * tidak ngubah state. Hanya satu mode boleh isRunning per domain pada satu waktu.
 */

const MODES = ["validasi", "kirim"];
const DEFAULT_MODE = "validasi";

let activeTab = null;
let activeHostname = "";
let activeMode = DEFAULT_MODE;

const $ = (id) => document.getElementById(id);

const els = {
  startDate: $("start-date"),
  endDate: $("end-date"),
  delayMs: $("delay-ms"),
  waitTimeout: $("wait-timeout"),
  skipOnError: $("skip-on-error"),
  pageSize: $("page-size"),
  pageSizeField: $("page-size-field"),
  statSuccess: $("stat-success"),
  statSkipped: $("stat-skipped"),
  statFailed: $("stat-failed"),
  statAttempted: $("stat-attempted"),
  currentPatient: $("current-patient"),
  btnStart: $("btn-start"),
  btnStartLabel: $("btn-start-label"),
  btnStop: $("btn-stop"),
  btnReset: $("btn-reset"),
  btnClearLog: $("btn-clear-log"),
  btnToggleFailed: $("btn-toggle-failed"),
  logList: $("log-list"),
  failedList: $("failed-list"),
  failedCount: $("failed-count"),
  statusBadge: $("status-badge"),
  domainLabel: $("domain-label"),
  domainNotice: $("domain-notice"),
  modeTabs: document.querySelectorAll(".mode-tab"),
};

const todayStr = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const getStateKey = (mode) =>
  activeHostname ? `autoclick_state:${activeHostname}:${mode}` : "";

const getLogKey = (mode) =>
  activeHostname ? `autoclick_logs:${activeHostname}:${mode}` : "";

const getActiveHostname = async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.url) return { tab: null, hostname: "" };
  try {
    const u = new URL(tab.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { tab, hostname: "" };
    }
    return { tab, hostname: u.hostname };
  } catch (_) {
    return { tab, hostname: "" };
  }
};

const getState = async (mode = activeMode) => {
  const key = getStateKey(mode);
  if (!key) return {};
  const data = await chrome.storage.local.get(key);
  return data[key] || {};
};

const saveState = async (patch, mode = activeMode) => {
  const key = getStateKey(mode);
  if (!key) return null;
  const current = await getState(mode);
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [key]: next });
  return next;
};

const renderModeUI = () => {
  els.modeTabs.forEach((tab) => {
    const isActive = tab.dataset.mode === activeMode;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  if (activeMode === "kirim") {
    els.pageSizeField.hidden = true;
    els.btnStartLabel.textContent = "Mulai Kirim Data";
  } else {
    els.pageSizeField.hidden = false;
    els.btnStartLabel.textContent = "Mulai Validasi";
  }
};

const renderState = (state) => {
  els.startDate.value = state.startDate || todayStr();
  els.endDate.value = state.endDate || state.startDate || todayStr();
  els.delayMs.value = state.delayMs ?? 1500;
  els.waitTimeout.value = state.waitTimeoutMs ?? 15000;
  els.skipOnError.checked = state.skipOnError !== false;
  els.pageSize.value = String(state.pageSize ?? 1000);

  const stats = state.stats || { success: 0, failed: 0, skipped: 0 };
  els.statSuccess.textContent = stats.success || 0;
  els.statSkipped.textContent = stats.skipped || 0;
  els.statFailed.textContent = stats.failed || 0;
  els.statAttempted.textContent = (state.attemptedIds || []).length;

  renderFailedList(state.failedDetails || []);

  els.currentPatient.textContent = `Pasien: ${state.currentPatient || "-"}`;

  if (state.isRunning) {
    els.statusBadge.textContent = "RUN";
    els.statusBadge.classList.remove("badge-off");
    els.statusBadge.classList.add("badge-on");
    els.btnStart.disabled = true;
    els.btnStop.disabled = false;
  } else {
    els.statusBadge.textContent = "OFF";
    els.statusBadge.classList.remove("badge-on");
    els.statusBadge.classList.add("badge-off");
    els.btnStart.disabled = !activeHostname;
    els.btnStop.disabled = true;
  }
};

const formatTime = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString("id-ID", { hour12: false });
  } catch (_) {
    return iso || "";
  }
};

const renderFailedList = (details) => {
  if (!els.failedList) return;
  els.failedList.innerHTML = "";
  els.failedCount.textContent = details.length;

  const recent = details.slice().reverse();
  for (const item of recent) {
    const row = document.createElement("div");
    row.className = `failed-item failed-item-type-${item.type || "failed"}`;

    const idEl = document.createElement("div");
    idEl.className = "failed-item-id";
    idEl.textContent = item.label || item.id || "(tidak diketahui)";

    const reasonEl = document.createElement("div");
    reasonEl.className = "failed-item-reason";
    reasonEl.textContent = item.reason || "(tanpa alasan)";

    const metaEl = document.createElement("div");
    metaEl.className = "failed-item-meta";
    const typeText = item.type === "skipped" ? "Skip" : "Gagal";
    metaEl.textContent = `${typeText} - ${formatTime(item.time)}${item.id ? " - " + item.id : ""}`;

    row.appendChild(idEl);
    row.appendChild(reasonEl);
    row.appendChild(metaEl);
    els.failedList.appendChild(row);
  }
};

const renderLogs = (logs) => {
  els.logList.innerHTML = "";
  const recent = (logs || []).slice(-80);
  for (const log of recent) {
    const row = document.createElement("div");
    row.className = "log-entry";
    const time = document.createElement("span");
    time.className = "log-time";
    const t = new Date(log.time);
    time.textContent = t.toLocaleTimeString("id-ID", { hour12: false });
    const msg = document.createElement("span");
    msg.className = `log-${log.level || "info"}`;
    msg.textContent = log.message;
    row.appendChild(time);
    row.appendChild(msg);
    els.logList.appendChild(row);
  }
  els.logList.scrollTop = els.logList.scrollHeight;
};

const loadLogs = async () => {
  const key = getLogKey(activeMode);
  if (!key) {
    renderLogs([]);
    return;
  }
  const data = await chrome.storage.local.get(key);
  renderLogs(data[key] || []);
};

const refreshUIFromStorage = async () => {
  const state = await getState();
  if (!state.startDate) {
    state.startDate = todayStr();
    state.endDate = todayStr();
  }
  renderState(state);
  await loadLogs();
};

const switchMode = async (newMode) => {
  if (!MODES.includes(newMode) || newMode === activeMode) return;

  const otherMode = activeMode;
  const otherState = await getState(otherMode);
  if (otherState.isRunning) {
    const ok = confirm(
      `Mode "${otherMode}" sedang berjalan. Stop dulu sebelum pindah ke "${newMode}"?\n\n` +
        `Tekan OK untuk stop & pindah, Cancel untuk tetap di mode "${otherMode}".`
    );
    if (!ok) return;
    await saveState({ isRunning: false }, otherMode);
  }

  activeMode = newMode;
  renderModeUI();
  await refreshUIFromStorage();
};

const handleStart = async () => {
  if (!activeHostname) {
    alert("Tab aktif bukan halaman web (http/https). Buka tab SIMPUS dulu, lalu klik icon ekstensi.");
    return;
  }

  for (const m of MODES) {
    if (m === activeMode) continue;
    const s = await getState(m);
    if (s.isRunning) {
      alert(`Mode "${m}" sedang aktif untuk domain ini. Stop dulu sebelum mulai mode "${activeMode}".`);
      return;
    }
  }

  const startDate = els.startDate.value;
  const endDate = els.endDate.value || startDate;
  const delayMs = Math.max(200, parseInt(els.delayMs.value, 10) || 1500);
  const waitTimeoutMs = Math.max(2000, parseInt(els.waitTimeout.value, 10) || 15000);
  const skipOnError = els.skipOnError.checked;
  const pageSize = parseInt(els.pageSize.value, 10) || 1000;

  if (!startDate) {
    alert("Tanggal mulai wajib diisi.");
    return;
  }

  await saveState({
    isRunning: true,
    mode: activeMode,
    startDate,
    endDate,
    delayMs,
    waitTimeoutMs,
    skipOnError,
    pageSize,
    attemptedIds: [],
    failedIds: [],
    failedDetails: [],
    stats: { success: 0, failed: 0, skipped: 0 },
    currentPatient: "",
    currentPatientId: "",
  });

  if (!activeTab || !activeTab.id) return;

  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: "TRIGGER_RUN" });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ["content.js"],
      });
      await chrome.tabs.sendMessage(activeTab.id, { type: "TRIGGER_RUN" });
    } catch (err) {
      console.warn("Gagal inject content script:", err);
    }
  }
};

const handleStop = async () => {
  await saveState({ isRunning: false });
};

const handleReset = async () => {
  if (
    !confirm(
      `Reset SEMUA data mode "${activeMode}" untuk domain "${activeHostname}"?\n\n` +
        `Statistik, blocklist pasien gagal, dan pasien aktif akan dihapus.`
    )
  )
    return;
  await saveState({
    stats: { success: 0, failed: 0, skipped: 0 },
    attemptedIds: [],
    failedIds: [],
    failedDetails: [],
    currentPatient: "",
    currentPatientId: "",
  });
};

const handleToggleFailed = () => {
  const isHidden = els.failedList.hasAttribute("hidden");
  if (isHidden) {
    els.failedList.removeAttribute("hidden");
    els.btnToggleFailed.textContent = "Sembunyikan";
    els.btnToggleFailed.setAttribute("aria-expanded", "true");
  } else {
    els.failedList.setAttribute("hidden", "");
    els.btnToggleFailed.textContent = "Tampilkan";
    els.btnToggleFailed.setAttribute("aria-expanded", "false");
  }
};

const handleClearLog = async () => {
  const key = getLogKey(activeMode);
  if (!key) return;
  await chrome.storage.local.set({ [key]: [] });
  renderLogs([]);
};

const renderDomainHeader = () => {
  if (activeHostname) {
    els.domainLabel.textContent = activeHostname;
    els.domainLabel.title = activeHostname;
    els.domainNotice.hidden = true;
    els.btnStart.disabled = false;
  } else {
    els.domainLabel.textContent = "(bukan tab web)";
    els.domainNotice.hidden = false;
    els.btnStart.disabled = true;
  }
};

/**
 * Saat popup dibuka, pilih mode aktif berdasar mana yang isRunning.
 * Kalau dua-duanya OFF, default ke "validasi".
 */
const detectInitialMode = async () => {
  for (const m of MODES) {
    const s = await getState(m);
    if (s.isRunning) return m;
  }
  return DEFAULT_MODE;
};

const init = async () => {
  const { tab, hostname } = await getActiveHostname();
  activeTab = tab;
  activeHostname = hostname;

  renderDomainHeader();

  if (activeHostname) {
    activeMode = await detectInitialMode();
  }

  renderModeUI();
  await refreshUIFromStorage();

  els.btnStart.addEventListener("click", handleStart);
  els.btnStop.addEventListener("click", handleStop);
  els.btnReset.addEventListener("click", handleReset);
  els.btnClearLog.addEventListener("click", handleClearLog);
  els.btnToggleFailed.addEventListener("click", handleToggleFailed);

  els.modeTabs.forEach((tab) => {
    tab.addEventListener("click", () => switchMode(tab.dataset.mode));
  });

  ["startDate", "endDate", "delayMs", "waitTimeout", "pageSize"].forEach((key) => {
    els[key].addEventListener("change", async () => {
      await saveState({
        startDate: els.startDate.value,
        endDate: els.endDate.value,
        delayMs: parseInt(els.delayMs.value, 10) || 1500,
        waitTimeoutMs: parseInt(els.waitTimeout.value, 10) || 15000,
        pageSize: parseInt(els.pageSize.value, 10) || 1000,
      });
    });
  });
  els.skipOnError.addEventListener("change", async () => {
    await saveState({ skipOnError: els.skipOnError.checked });
  });
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const stateKey = getStateKey(activeMode);
  const logKey = getLogKey(activeMode);
  if (stateKey && changes[stateKey]) {
    renderState(changes[stateKey].newValue || {});
  }
  if (logKey && changes[logKey]) {
    renderLogs(changes[logKey].newValue || []);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "FINISHED") {
    loadLogs();
  }
});

init();
