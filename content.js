/**
 * AutoClick SatuSehat - Content Script
 *
 * State machine yang berjalan di setiap halaman SIMPUS / SatuSehat.
 * State disimpan di chrome.storage.local supaya tetap nyambung
 * walaupun terjadi navigasi antar halaman (list <-> detail).
 *
 * Workflow:
 *   1. Halaman LIST   -> set tanggal -> klik tombol mata pasien pertama
 *   2. Halaman DETAIL -> klik Validasi -> klik Yakin
 *   3. Tunggu redirect / toast warning
 *   4. Balik ke LIST -> ulangi
 */

(() => {
  "use strict";

  /**
   * State diisolasi per-hostname supaya 1 ekstensi bisa dipakai di banyak
   * client SIMPUS sekaligus tanpa saling polusi (stats, blocklist, dll).
   * Contoh hostname: "satusehat-simpus-kuta-selatan.badungkab.go.id"
   */
  const HOSTNAME = (location && location.hostname) || "default";
  const STORAGE_KEY = `autoclick_state:${HOSTNAME}`;
  const LOG_KEY = `autoclick_logs:${HOSTNAME}`;
  const MAX_LOGS = 200;

  const DEFAULT_CONFIG = {
    isRunning: false,
    startDate: "",
    endDate: "",
    delayMs: 1500,
    waitTimeoutMs: 15000,
    skipOnError: true,
    pageSize: 1000,
    stats: { success: 0, failed: 0, skipped: 0 },
    attemptedIds: [],
    failedIds: [],
    failedDetails: [],
    currentPatientId: "",
    currentPatient: "",
  };

  const PAGE_SIZE_OPTIONS = [20, 50, 100, 500, 1000];

  const MAX_FAILED_DETAILS = 100;

  /* ---------- Helpers umum ---------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Cek apakah extension context masih valid.
   * Saat user reload extension di chrome://extensions, content script
   * lama jadi "orphaned" - chrome.runtime.id berubah jadi undefined.
   */
  const isContextValid = () => {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  };

  let contextWarned = false;
  const handleInvalidContext = () => {
    if (!contextWarned) {
      contextWarned = true;
      console.warn(
        "[AutoClick] Extension context invalidated. Refresh halaman SIMPUS untuk re-inject content script."
      );
    }
  };

  const getState = async () => {
    if (!isContextValid()) {
      handleInvalidContext();
      return { ...DEFAULT_CONFIG };
    }
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      return { ...DEFAULT_CONFIG, ...(data[STORAGE_KEY] || {}) };
    } catch (_) {
      handleInvalidContext();
      return { ...DEFAULT_CONFIG };
    }
  };

  const setState = async (patch) => {
    if (!isContextValid()) {
      handleInvalidContext();
      return null;
    }
    try {
      const current = await getState();
      const next = { ...current, ...patch };
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
      return next;
    } catch (_) {
      handleInvalidContext();
      return null;
    }
  };

  const pushLog = async (level, message) => {
    const tag = `[AutoClick:${level}]`;
    if (level === "error") console.error(tag, message);
    else if (level === "warn") console.warn(tag, message);
    else console.log(tag, message);

    if (!isContextValid()) {
      handleInvalidContext();
      return;
    }

    const time = new Date().toISOString();
    const entry = { time, level, message };

    try {
      const data = await chrome.storage.local.get(LOG_KEY);
      const logs = data[LOG_KEY] || [];
      logs.push(entry);
      if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
      await chrome.storage.local.set({ [LOG_KEY]: logs });
    } catch (_) {
      handleInvalidContext();
      return;
    }

    try {
      const p = chrome.runtime.sendMessage({ type: "LOG", entry });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {}
  };

  const waitForElement = async (predicate, timeoutMs = 15000, intervalMs = 200) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = predicate();
      if (el) return el;
      await sleep(intervalMs);
    }
    return null;
  };

  const findByText = (selector, text) => {
    const target = text.trim().toLowerCase();
    const nodes = document.querySelectorAll(selector);
    for (const n of nodes) {
      const t = (n.textContent || "").trim().toLowerCase();
      if (t === target || t.includes(target)) return n;
    }
    return null;
  };

  /**
   * React-friendly value setter untuk input.
   * React menyimpan internal value tracker, jadi assign biasa tidak terdeteksi.
   */
  const setNativeValue = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) {
      setter.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const realClick = (el) => {
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    return true;
  };

  /* ---------- Detector & finder spesifik SIMPUS ---------- */

  const findEyeButtons = () => {
    const buttons = [];
    const icons = document.querySelectorAll("i.fa-eye, i.far.fa-eye, i.fas.fa-eye");
    icons.forEach((i) => {
      const btn = i.closest("button, a");
      if (btn) buttons.push(btn);
    });
    return buttons;
  };

  /**
   * Ambil identitas unik pasien dari row tabel.
   * Prioritas: NoReg (pattern REG-xxxxxx) -> NRM -> NIK -> gabungan kolom awal.
   * Identitas ini dipakai untuk flagging supaya pasien yang sudah dicoba
   * tidak diproses ulang (terutama yang gagal).
   */
  const getRowPatientId = (row) => {
    if (!row) return null;
    const tds = Array.from(row.querySelectorAll("td"));
    const texts = tds
      .map((td) => (td.textContent || "").trim())
      .filter((t) => t && t.length > 0);

    const noReg = texts.find((t) => /REG[-\s]?\d+/i.test(t));
    if (noReg) return `NOREG:${noReg}`;

    const nik = texts.find((t) => /^\d{16}$/.test(t));
    if (nik) return `NIK:${nik}`;

    const nrm = texts.find((t) => /^\d{2}\.\d{2}\.\d{2,}$/.test(t));
    if (nrm) return `NRM:${nrm}`;

    const composite = texts.slice(0, 4).join("|");
    return composite ? `ROW:${composite}` : null;
  };

  /**
   * Ambil label readable dari row buat ditampilkan di log/popup.
   */
  const getRowPatientLabel = (row) => {
    if (!row) return "(tidak diketahui)";
    return Array.from(row.querySelectorAll("td"))
      .slice(0, 6)
      .map((td) => (td.textContent || "").trim())
      .filter(Boolean)
      .join(" | ")
      .slice(0, 200);
  };

  /**
   * Cari tombol mata pertama yang ID pasiennya BELUM ada di attemptedIds.
   */
  const findUnprocessedEyePair = (attemptedIds = []) => {
    const blocked = new Set(attemptedIds);
    const buttons = findEyeButtons();
    for (const btn of buttons) {
      const row = btn.closest("tr");
      const id = getRowPatientId(row);
      if (!id) {
        return { btn, row, id: null };
      }
      if (!blocked.has(id)) {
        return { btn, row, id };
      }
    }
    return null;
  };

  const findValidasiButton = () => {
    const candidates = document.querySelectorAll(
      "button.btn-primary.d-block.w-100, button.btn.btn-primary"
    );
    for (const b of candidates) {
      const txt = (b.textContent || "").trim().toLowerCase();
      if (txt.includes("validasi")) return b;
    }
    return findByText("button", "Validasi");
  };

  const findYakinButton = () => {
    const modal = document.querySelector(".modal.show, .modal.fade.show");
    const root = modal || document;
    const buttons = root.querySelectorAll(".modal-footer button, button");
    for (const b of buttons) {
      const txt = (b.textContent || "").trim().toLowerCase();
      if (txt === "yakin") return b;
    }
    return null;
  };

  const findStartDateInput = () =>
    document.querySelector(
      'input#startDate, input[name="startDate"], input[name="start_date"]'
    );

  const findEndDateInput = () =>
    document.querySelector(
      'input#endDate, input[name="endDate"], input[name="end_date"]'
    );

  /**
   * Cari container dropdown "Total data" di halaman list.
   * Hasil bisa berupa:
   *  - { type: 'select', el }       -> native <select>
   *  - { type: 'custom', el, container } -> custom react select
   */
  const findTotalDataDropdown = () => {
    const labels = document.querySelectorAll("label");
    for (const label of labels) {
      const txt = (label.textContent || "").trim().toLowerCase();
      if (txt === "total data" || txt.includes("total data")) {
        const container =
          label.closest(".col-lg-3, .col-lg-2, .col-md-3, .col-md-2, .form-group, [class*='col-']") ||
          label.parentElement;
        if (!container) continue;

        const select = container.querySelector("select");
        if (select) return { type: "select", el: select, container };

        const inputBox =
          container.querySelector(".mahas-form-input") ||
          container.querySelector("[class*='mahas-form-input']") ||
          container.querySelector("input") ||
          container.querySelector(".form-control");
        if (inputBox) return { type: "custom", el: inputBox, container };
      }
    }
    return null;
  };

  /**
   * Cek nilai page size yang aktif sekarang berdasar text di container.
   * Return number atau null kalau tidak bisa baca.
   */
  const getCurrentPageSize = (container) => {
    if (!container) return null;
    const inputEl = container.querySelector("input");
    if (inputEl && inputEl.value) {
      const n = parseInt(inputEl.value, 10);
      if (!isNaN(n)) return n;
    }
    const text = (container.textContent || "").replace(/total\s*data/i, "").trim();
    const match = text.match(/\b(20|50|100|500|1000)\b/);
    if (match) return parseInt(match[1], 10);
    return null;
  };

  /**
   * Set nilai dropdown "Total data" ke targetValue.
   * - Native select: pakai setNativeValue.
   * - Custom dropdown: klik container -> tunggu options -> klik option yang match.
   */
  const setPageSize = async (targetValue, delayMs) => {
    const target = parseInt(targetValue, 10);
    if (!target || isNaN(target)) return false;

    const found = findTotalDataDropdown();
    if (!found) {
      await pushLog("warn", "Dropdown 'Total data' tidak ditemukan, dilewati.");
      return false;
    }

    const current = getCurrentPageSize(found.container);
    if (current === target) {
      return true;
    }

    if (found.type === "select") {
      await pushLog("info", `Set Total data: ${target}`);
      setNativeValue(found.el, String(target));
      await sleep(delayMs);
      return true;
    }

    await pushLog("info", `Set Total data: ${target}`);
    realClick(found.el);
    await sleep(300);

    const targetText = String(target);
    const optionSelectors = [
      ".mahas-form-input li",
      ".mahas-form-input [class*='option']",
      "[class*='mahas'] li",
      "ul[role='listbox'] li",
      "[role='option']",
      ".dropdown-menu.show li",
      ".dropdown-menu.show .dropdown-item",
      ".select-options li",
    ];

    let option = null;
    const start = Date.now();
    while (Date.now() - start < 4000 && !option) {
      for (const sel of optionSelectors) {
        const candidates = document.querySelectorAll(sel);
        for (const c of candidates) {
          const txt = (c.textContent || "").trim();
          if (txt === targetText) {
            option = c;
            break;
          }
        }
        if (option) break;
      }
      if (!option) await sleep(150);
    }

    if (!option) {
      await pushLog("warn", `Opsi ${target} tidak ditemukan di dropdown. Coba ketik manual.`);
      const inputEl = found.container.querySelector("input");
      if (inputEl) {
        setNativeValue(inputEl, targetText);
        inputEl.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        );
      }
      document.body.click();
      await sleep(delayMs);
      return false;
    }

    realClick(option);
    await sleep(delayMs);
    return true;
  };

  const isListPage = () => {
    const hasTable = !!document.querySelector("table");
    const hasEye = findEyeButtons().length > 0;
    const hasDateFilter = !!findStartDateInput();
    return (hasTable && hasEye) || hasDateFilter;
  };

  const isDetailPage = () => {
    if (findValidasiButton()) return true;
    const hasIdentitas = Array.from(document.querySelectorAll("h3, h4, h5, label, div"))
      .some((n) => /identitas\s*pasien/i.test(n.textContent || ""));
    return hasIdentitas;
  };

  const isModalOpen = () =>
    !!document.querySelector(".modal.show, .modal.fade.show");

  /* ---------- Deteksi notifikasi / toast ---------- */

  /**
   * Cari toast yang baru muncul. SIMPUS tampaknya pakai toast top-right
   * dengan judul "Warning". Selectornya beragam, jadi pakai pendekatan
   * yang permisif: cocokkan beberapa class umum + cek text "warning".
   */
  const findActiveToast = () => {
    const candidates = document.querySelectorAll(
      ".Toastify__toast, .toast.show, .toast-message, [class*='Toastify__toast'], [class*='toast'], [class*='notification'], [role='alert']"
    );
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const text = (el.textContent || "").trim();
      if (text.length === 0) continue;
      return { el, text };
    }
    return null;
  };

  /**
   * Tunggu notifikasi muncul setelah klik Yakin, atau redirect otomatis,
   * mana yang lebih dulu. Mengembalikan: 'success' | 'warning' | 'timeout'.
   */
  const waitForResultAfterYakin = async (timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const toast = findActiveToast();
      if (toast) {
        const lower = toast.text.toLowerCase();
        if (
          lower.includes("warning") ||
          lower.includes("error") ||
          lower.includes("gagal") ||
          lower.includes("invalid")
        ) {
          return { kind: "warning", message: toast.text.slice(0, 300) };
        }
        if (
          lower.includes("success") ||
          lower.includes("berhasil") ||
          lower.includes("sukses")
        ) {
          return { kind: "success", message: toast.text.slice(0, 300) };
        }
      }
      if (!isModalOpen() && !findValidasiButton()) {
        return { kind: "success", message: "Redirect terdeteksi" };
      }
      await sleep(250);
    }
    return { kind: "timeout", message: "Tidak ada respon dalam waktu tunggu" };
  };

  /* ---------- Workflow utama ---------- */

  let isProcessing = false;

  const handleListPage = async () => {
    const state = await getState();
    if (!state.isRunning) return;

    await pushLog("info", "Halaman LIST terdeteksi.");

    if (state.pageSize) {
      await setPageSize(state.pageSize, state.delayMs);
    }

    const startInput = findStartDateInput();
    const endInput = findEndDateInput();

    if (startInput && state.startDate && startInput.value !== state.startDate) {
      await pushLog("info", `Set tanggal mulai: ${state.startDate}`);
      setNativeValue(startInput, state.startDate);
      await sleep(state.delayMs);
    }
    if (endInput && state.endDate && endInput.value !== state.endDate) {
      await pushLog("info", `Set tanggal sampai: ${state.endDate}`);
      setNativeValue(endInput, state.endDate);
      await sleep(state.delayMs);
    }

    const attemptedIds = state.attemptedIds || [];
    const pair = await waitForElement(
      () => findUnprocessedEyePair(attemptedIds),
      state.waitTimeoutMs
    );

    if (!pair) {
      const totalEye = findEyeButtons().length;
      const message =
        totalEye === 0
          ? "Tidak ada pasien tersisa di list. Proses selesai."
          : `Semua pasien (${totalEye}) di halaman ini sudah pernah diproses. Proses selesai.`;
      await pushLog("info", message);
      await setState({ isRunning: false, currentPatient: "", currentPatientId: "" });
      try {
        chrome.runtime.sendMessage({ type: "FINISHED" }).catch(() => {});
      } catch (_) {}
      return;
    }

    const { btn, row, id } = pair;
    const patientLabel = getRowPatientLabel(row);
    const patientId = id || `ROW_INDEX:${Date.now()}`;

    const nextAttempted = attemptedIds.includes(patientId)
      ? attemptedIds
      : [...attemptedIds, patientId];

    await setState({
      currentPatient: patientLabel,
      currentPatientId: patientId,
      attemptedIds: nextAttempted,
    });
    await pushLog("info", `Buka detail pasien: ${patientLabel}`);
    realClick(btn);
  };

  const handleDetailPage = async () => {
    const state = await getState();
    if (!state.isRunning) return;

    await pushLog("info", "Halaman DETAIL terdeteksi.");

    const validasiBtn = await waitForElement(findValidasiButton, state.waitTimeoutMs);
    if (!validasiBtn) {
      await pushLog("error", "Tombol Validasi tidak ditemukan.");
      await markFailed(state, "Tombol Validasi tidak ditemukan");
      await goBackToList(state);
      return;
    }
    await sleep(state.delayMs);
    await pushLog("info", "Klik tombol Validasi.");
    realClick(validasiBtn);

    const yakinBtn = await waitForElement(findYakinButton, state.waitTimeoutMs);
    if (!yakinBtn) {
      await pushLog("error", "Tombol Yakin tidak ditemukan (modal tidak muncul).");
      await markFailed(state, "Modal Yakin tidak muncul");
      await goBackToList(state);
      return;
    }
    await sleep(state.delayMs);
    await pushLog("info", "Klik tombol Yakin.");
    realClick(yakinBtn);

    const result = await waitForResultAfterYakin(state.waitTimeoutMs);
    if (result.kind === "success") {
      await pushLog("success", `Validasi berhasil. ${result.message}`);
      await incStat("success");
    } else if (result.kind === "warning") {
      await pushLog("warn", `Notifikasi: ${result.message}`);
      await markFailed(state, result.message, "skipped");
      if (state.skipOnError) {
        await goBackToList(state);
      } else {
        await setState({ isRunning: false });
      }
    } else {
      await pushLog("error", `Timeout setelah klik Yakin.`);
      await markFailed(state, "Timeout setelah klik Yakin");
      await goBackToList(state);
    }
  };

  const incStat = async (key) => {
    const state = await getState();
    const stats = { ...state.stats, [key]: (state.stats[key] || 0) + 1 };
    await setState({ stats });
  };

  /**
   * Tandai pasien aktif sebagai gagal:
   *  - Tambahkan ID-nya ke failedIds (selain attemptedIds yang sudah masuk saat klik mata).
   *  - Simpan detail (id, label, reason, time) di failedDetails buat ditampilkan di popup.
   *  - Naikkan counter stats (default 'failed', bisa 'skipped' kalau warning dari server).
   */
  const markFailed = async (state, reason, statKey = "failed") => {
    const id = state.currentPatientId || "";
    const label = state.currentPatient || "(tidak diketahui)";

    const failedIds = state.failedIds || [];
    const nextFailedIds = id && !failedIds.includes(id) ? [...failedIds, id] : failedIds;

    const failedDetails = state.failedDetails || [];
    const entry = {
      id,
      label,
      reason: (reason || "").slice(0, 300),
      time: new Date().toISOString(),
      type: statKey,
    };
    const nextDetails = [...failedDetails, entry];
    if (nextDetails.length > MAX_FAILED_DETAILS) {
      nextDetails.splice(0, nextDetails.length - MAX_FAILED_DETAILS);
    }

    const stats = { ...state.stats, [statKey]: (state.stats[statKey] || 0) + 1 };

    await setState({
      failedIds: nextFailedIds,
      failedDetails: nextDetails,
      stats,
    });
  };

  const goBackToList = async (state) => {
    await sleep(state.delayMs);
    if (isListPage()) return;
    try {
      history.back();
    } catch (e) {
      await pushLog("error", `Gagal back: ${e.message}`);
    }
  };

  /* ---------- Bootstrap ---------- */

  const run = async () => {
    if (isProcessing) return;
    if (!isContextValid()) {
      handleInvalidContext();
      return;
    }
    isProcessing = true;
    try {
      const state = await getState();
      if (!state.isRunning) return;

      await sleep(500);

      if (isDetailPage()) {
        await handleDetailPage();
      } else if (isListPage()) {
        await handleListPage();
      } else {
        await pushLog("info", "Halaman tidak dikenali. Menunggu...");
      }
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/Extension context invalidated|message port closed/i.test(msg)) {
        handleInvalidContext();
      } else {
        await pushLog("error", `Exception: ${msg}`);
      }
    } finally {
      isProcessing = false;
    }
  };

  /**
   * SPA (React) sering tidak full reload saat pindah halaman.
   * Kita pantau perubahan URL via popstate + observer pada body.
   */
  let lastUrl = location.href;
  const onUrlMaybeChanged = () => {
    if (!isContextValid()) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(run, 600);
    }
  };

  const bodyObserver = new MutationObserver(() => {
    onUrlMaybeChanged();
  });
  if (document.body) {
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  window.addEventListener("popstate", () => {
    if (isContextValid()) setTimeout(run, 400);
  });
  window.addEventListener("hashchange", () => {
    if (isContextValid()) setTimeout(run, 400);
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (!isContextValid()) return;
      if (area !== "local") return;
      if (changes[STORAGE_KEY]) {
        const next = changes[STORAGE_KEY].newValue;
        const prev = changes[STORAGE_KEY].oldValue;
        if (next && next.isRunning && (!prev || !prev.isRunning)) {
          setTimeout(run, 200);
        }
      }
    });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!isContextValid()) return false;
      if (msg && msg.type === "TRIGGER_RUN") {
        run().then(() => {
          try {
            sendResponse({ ok: true });
          } catch (_) {}
        });
        return true;
      }
      if (msg && msg.type === "PING") {
        try {
          sendResponse({
            ok: true,
            page: isDetailPage() ? "detail" : isListPage() ? "list" : "unknown",
          });
        } catch (_) {}
        return false;
      }
      return false;
    });
  } catch (_) {
    handleInvalidContext();
  }

  if (isContextValid()) {
    setTimeout(run, 800);
  } else {
    handleInvalidContext();
  }
})();
