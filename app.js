/**
 * ============================================================================
 *  MANAJEMEN SERVIS AC RUMAH — app.js
 * ============================================================================
 *  Vanilla JavaScript — tidak menggunakan framework apapun.
 *  Berkomunikasi dengan backend Google Apps Script (Code.gs) via fetch API.
 * ============================================================================
 */

// ============================================================================
// KONFIGURASI — SESUAIKAN BAGIAN INI
// ============================================================================
const CONFIG = {
  // 1) Deploy Code.gs sebagai Web App (lihat README.md untuk langkah lengkap)
  // 2) Tempel URL Web App hasil deploy di bawah ini, contoh:
  //    "https://script.google.com/macros/s/AKfycbx.../exec"
  WEB_APP_URL: "https://script.google.com/macros/s/AKfycbzZoxs1Ht08Ei_ijKwxuhApz8crptHEH_nqQKiSi7ClGEf6tyCQLS4-iez1MrLDZXhWIA/exec",

  // Daftar unit AC — ubah sesuai kebutuhan rumah Anda.
  // "merk" dan "pk" bersifat tetap per unit (spesifikasi fisik AC-nya),
  // beda dengan data servis (tanggal/teknisi/catatan) yang berubah tiap kali diservis.
  // GANTI nilai merk & pk di bawah ini sesuai AC Anda yang sebenarnya.
  UNITS: [
    { name: "AC Kamar Utama", merk: "Electrolux CSR-09CR", pk: "1 PK" },
    { name: "AC Kamar Nayla", merk: "Panasonic CS-ZNSYKP", pk: "0.5 PK" },
    { name: "AC Kamar Arimbi", merk: "Panasonic CS-PCGPKJ", pk: "1 PK" },
    { name: "AC Studio", merk: "GREE 6WC-09158/1", pk: "1 PK" }
  ],

  // Interval servis berkala (bulan)
  SERVICE_INTERVAL_MONTHS: 2,

  // Berapa hari sebelum jatuh tempo, status berubah jadi "Segera Servis" (kuning)
  WARNING_DAYS_BEFORE: 14,

  // Key untuk cache offline di localStorage
  CACHE_KEY: "servisAC_cache_v1",

  // Durasi acara pengingat kalender (menit)
  CALENDAR_EVENT_DURATION_MINUTES: 60
};

// ============================================================================
// STATE
// ============================================================================
let allRecords = []; // seluruh data riwayat servis dari server/cache (aktif MAUPUN arsip)
let activeRiwayatFilter = "Semua";
let activeKalenderContext = null; // { unit, nextDate }
let editingRecordId = null; // null = mode tambah baru, terisi = sedang edit record dengan ID ini
let confirmCallback = null; // fungsi yang dijalankan kalau modal konfirmasi ditekan "Ya"

const STATUS_ARSIP = "Arsip";

/** Record dianggap arsip HANYA kalau recordStatus eksplisit "Arsip".
 *  Data lama (sebelum kolom Status ada di Sheets) tidak punya field ini sama
 *  sekali -> harus dianggap AKTIF, bukan malah hilang dari Riwayat/Dashboard. */
function isArchived(r) {
  return r.recordStatus === STATUS_ARSIP;
}

// ============================================================================
// DOM SHORTCUTS
// ============================================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const el = {
  headerSubtitle: $("#header-subtitle"),
  offlineBanner: $("#offline-banner"),
  dashboardCards: $("#dashboard-cards"),
  summaryBadge: $("#summary-badge"),
  riwayatList: $("#riwayat-list"),
  riwayatFilter: $("#riwayat-filter"),
  arsipList: $("#arsip-list"),
  btnRefresh: $("#btn-refresh"),
  refreshIcon: $("#refresh-icon"),
  btnExportPdf: $("#btn-export-pdf"),
  btnFab: $("#btn-fab"),
  modalServis: $("#modal-servis"),
  modalServisTitle: $("#modal-servis-title"),
  formServis: $("#form-servis"),
  btnSubmitServis: $("#btn-submit-servis"),
  btnSubmitLabel: $("#btn-submit-label"),
  modalKalender: $("#modal-kalender"),
  kalenderInfo: $("#kalender-info"),
  btnAddGoogleCalendar: $("#btn-add-google-calendar"),
  btnDownloadIcs: $("#btn-download-ics"),
  modalConfirm: $("#modal-confirm"),
  confirmTitle: $("#confirm-title"),
  confirmMessage: $("#confirm-message"),
  btnConfirmYes: $("#btn-confirm-yes"),
  toast: $("#toast"),
  loadingOverlay: $("#loading-overlay"),
  pdfTemplate: $("#pdf-export-template")
};

// ============================================================================
// INIT UI DARI CONFIG.UNITS (satu sumber untuk dropdown form & filter riwayat,
// supaya kalau CONFIG.UNITS diubah, seluruh UI otomatis ikut berubah)
// ============================================================================
function initUnitOptionsUI() {
  // Opsi dropdown "Unit AC" di form Catat Servis.
  // Buang dulu semua <option> selain placeholder (option pertama) sebelum
  // mengisi ulang — jaga-jaga kalau ada opsi hardcode lama tersisa di HTML
  // (versi index.html yang belum ter-update), supaya tidak dobel.
  const select = document.querySelector("#input-unit");
  while (select.options.length > 1) {
    select.remove(1);
  }
  CONFIG.UNITS.forEach((unit) => {
    const opt = document.createElement("option");
    opt.value = unit.name;
    opt.textContent = unit.name;
    select.appendChild(opt);
  });

  // Chip filter di tab Riwayat — buang dulu semua chip selain "Semua" (chip pertama).
  while (el.riwayatFilter.children.length > 1) {
    el.riwayatFilter.removeChild(el.riwayatFilter.lastChild);
  }
  CONFIG.UNITS.forEach((unit) => {
    const btn = document.createElement("button");
    btn.dataset.filter = unit.name;
    btn.className = "filter-chip";
    btn.textContent = unit.name.replace(/^AC\s+/i, "");
    el.riwayatFilter.appendChild(btn);
  });
}
initUnitOptionsUI();

// ============================================================================
// UTIL: TANGGAL
// ============================================================================
const BULAN_ID = [
  "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
  "Jul", "Agu", "Sep", "Okt", "Nov", "Des"
];

/** Parse "YYYY-MM-DD" -> Date (jam 12:00 lokal, menghindari pergeseran timezone).
 *  Punya fallback untuk format tanggal lain (mis. data lama dari sebelum
 *  Code.gs diperbaiki, yang sempat mengirim "Mon Aug 24 2026 00:00:00 GMT+..."
 *  alih-alih "YYYY-MM-DD") supaya tidak dianggap "tidak ada data servis"
 *  hanya karena formatnya belum standar. */
function parseDateStr(str) {
  if (!str) return null;
  const s = String(str).trim();

  let match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
    if (y && m && d) return new Date(y, m - 1, d, 12, 0, 0);
  }

  // Fallback #1: format hasil Date.toString() (mis. "Mon Aug 24 2026 00:00:00
  // GMT+0700 (...)"), yang sempat dikirim backend versi lama sebelum Code.gs
  // diperbaiki. Komponen tanggal diambil LANGSUNG dari teksnya (bukan lewat
  // `new Date(s)` lalu baca local Y/M/D) supaya tidak bergeser 1 hari
  // tergantung timezone perangkat/browser yang membuka aplikasi.
  const BULAN_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  match = s.match(/^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{4})/);
  if (match) {
    const monthIdx = BULAN_EN.indexOf(match[1]);
    const d = Number(match[2]), y = Number(match[3]);
    if (monthIdx !== -1 && d && y) return new Date(y, monthIdx, d, 12, 0, 0);
  }

  // Fallback #2 (terakhir): biarkan JavaScript mencoba parse format lain yang
  // belum diantisipasi di atas. Ini masih bisa bergeser tergantung timezone
  // browser, tapi lebih baik daripada dianggap "tidak ada data servis".
  const fallback = new Date(s);
  if (!isNaN(fallback.getTime())) {
    return new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate(), 12, 0, 0);
  }

  return null;
}

/** Date -> "YYYY-MM-DD" */
function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Date -> "24 Agu 2026" */
function formatDateID(date) {
  if (!date) return "-";
  return `${date.getDate()} ${BULAN_ID[date.getMonth()]} ${date.getFullYear()}`;
}

/** Tambah bulan ke sebuah Date, dengan clamping tanggal akhir bulan */
function addMonthsClamped(date, months) {
  const day = date.getDate();
  const result = new Date(date.getFullYear(), date.getMonth() + months, 1, 12, 0, 0);
  const lastDayOfResultMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDayOfResultMonth));
  return result;
}

function daysBetween(a, b) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / MS_PER_DAY);
}

// ============================================================================
// UTIL: TOAST & LOADING
// ============================================================================
let toastTimer = null;
function showToast(message, type = "info") {
  el.toast.textContent = message;
  el.toast.className = `toast fixed left-1/2 -translate-x-1/2 z-[60] px-4 py-3 rounded-2xl shadow-xl text-sm font-medium text-white toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 2800);
}

function setLoading(isLoading) {
  el.loadingOverlay.classList.toggle("hidden", !isLoading);
}

// ============================================================================
// DATA: FETCH & CACHE
// ============================================================================
function isConfigured() {
  return CONFIG.WEB_APP_URL && CONFIG.WEB_APP_URL.startsWith("http");
}

function saveCache(data) {
  try {
    localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify({ data, savedAt: Date.now() }));
  } catch (e) { /* storage penuh / tidak tersedia — abaikan */ }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CONFIG.CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/** Pastikan tiap record punya recordStatus (data lama dari sebelum ada kolom
 *  Status di Sheets tidak punya field ini -> default "Aktif", bukan hilang). */
function normalizeRecords(records) {
  return (records || []).map((r) => ({ ...r, recordStatus: r.recordStatus || "Aktif" }));
}

async function fetchServiceData() {
  if (!isConfigured()) {
    el.headerSubtitle.textContent = "⚠️ URL Google Apps Script belum diatur";
    const cached = loadCache();
    allRecords = normalizeRecords(cached ? cached.data : []);
    renderAll();
    return;
  }

  try {
    const res = await fetch(CONFIG.WEB_APP_URL, { method: "GET", redirect: "follow" });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message || "Gagal mengambil data");

    allRecords = normalizeRecords(json.data);
    saveCache(allRecords);
    el.offlineBanner.classList.add("hidden");
    el.headerSubtitle.textContent = `Terakhir sinkron: ${new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (err) {
    console.warn("[fetchServiceData] gagal:", err);
    const cached = loadCache();
    if (cached) {
      allRecords = normalizeRecords(cached.data);
      el.offlineBanner.classList.remove("hidden");
      el.headerSubtitle.textContent = "Data tersimpan (offline)";
    } else {
      allRecords = [];
      el.headerSubtitle.textContent = "Gagal memuat data";
      showToast("Tidak bisa terhubung ke server. Periksa koneksi Anda.", "error");
    }
  }

  renderAll();
}

async function submitServiceRecord(payload) {
  if (!isConfigured()) {
    showToast("URL Google Apps Script belum diatur di app.js", "error");
    return false;
  }
  try {
    // Content-Type "text/plain" sengaja dipakai agar browser tidak melakukan
    // CORS preflight (OPTIONS) — Apps Script akan tetap membaca body sebagai JSON.
    const res = await fetch(CONFIG.WEB_APP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message || "Gagal menyimpan data");
    return true;
  } catch (err) {
    console.error("[submitServiceRecord] gagal:", err);
    showToast("Gagal menyimpan: " + err.message, "error");
    return false;
  }
}

async function archiveRecord(id) {
  if (!isConfigured()) {
    showToast("URL Google Apps Script belum diatur di app.js", "error");
    return false;
  }
  try {
    const res = await fetch(CONFIG.WEB_APP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "archive", id })
    });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message || "Gagal menghapus data");
    return true;
  } catch (err) {
    console.error("[archiveRecord] gagal:", err);
    showToast("Gagal menghapus: " + err.message, "error");
    return false;
  }
}

async function restoreRecord(id) {
  if (!isConfigured()) {
    showToast("URL Google Apps Script belum diatur di app.js", "error");
    return false;
  }
  try {
    const res = await fetch(CONFIG.WEB_APP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "restore", id })
    });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message || "Gagal memulihkan data");
    return true;
  } catch (err) {
    console.error("[restoreRecord] gagal:", err);
    showToast("Gagal memulihkan: " + err.message, "error");
    return false;
  }
}

// ============================================================================
// LOGIKA STATUS UNIT AC
// ============================================================================
/**
 * Mengembalikan record terakhir (berdasarkan tanggalServis) untuk sebuah unit.
 */
function getLatestRecordForUnit(unitName) {
  const target = (unitName || "").trim().toLowerCase();
  const records = allRecords
    // "tanggalServis" wajib ada DAN harus bisa di-parse jadi tanggal valid (format YYYY-MM-DD).
    // Baris dengan format tanggal rusak di Google Sheets sengaja diabaikan di sini,
    // supaya tidak membuat seluruh dashboard gagal render (lihat catatan di renderDashboard).
    // Pencocokan nama unit di-trim+lowercase supaya tidak gagal gara-gara spasi/kapital
    // ekstra yang mungkin masuk lewat Google Sheets. Record yang sudah diarsipkan (dihapus)
    // TIDAK dihitung sebagai servis terakhir.
    .filter((r) => (r.unitAC || "").trim().toLowerCase() === target && !isArchived(r) && r.tanggalServis && parseDateStr(r.tanggalServis))
    .sort((a, b) => parseDateStr(b.tanggalServis) - parseDateStr(a.tanggalServis));
  return records[0] || null;
}

function getUnitStatus(unitName) {
  const latest = getLatestRecordForUnit(unitName);
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  if (!latest) {
    return {
      unit: unitName,
      lastDate: null,
      nextDate: null,
      statusKey: "servis",
      statusLabel: "Belum Pernah Servis",
      latestRecord: null
    };
  }

  const lastDate = parseDateStr(latest.tanggalServis);
  // Jaga-jaga tambahan: kalaupun lolos sampai sini, jangan sampai lastDate null bikin crash.
  if (!lastDate) {
    return {
      unit: unitName,
      lastDate: null,
      nextDate: null,
      statusKey: "servis",
      statusLabel: "Format Tanggal Tidak Valid",
      latestRecord: latest
    };
  }
  const nextDate = addMonthsClamped(lastDate, CONFIG.SERVICE_INTERVAL_MONTHS);
  const diff = daysBetween(today, nextDate); // positif = masih ke depan

  let statusKey, statusLabel;
  if (diff <= 0) {
    statusKey = "servis";
    statusLabel = "Waktunya Servis";
  } else if (diff <= CONFIG.WARNING_DAYS_BEFORE) {
    statusKey = "segera";
    statusLabel = `Segera Servis (${diff} hari lagi)`;
  } else {
    statusKey = "aman";
    statusLabel = "Aman";
  }

  return { unit: unitName, lastDate, nextDate, statusKey, statusLabel, latestRecord: latest };
}

// ============================================================================
// RENDER: DASHBOARD
// ============================================================================
const AC_ICON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5">
    <rect x="2.5" y="5" width="19" height="8" rx="2" />
    <path d="M6 13v2" /><path d="M12 13v3" /><path d="M18 13v2" />
    <path d="M6.5 8.5h11" />
  </svg>`;

function renderDashboard() {
  // Hitung status semua unit SEKALI di sini (dipakai ulang untuk kartu & badge ringkasan),
  // dibungkus try/catch per unit supaya satu data yang bermasalah tidak menjatuhkan semuanya.
  const statuses = CONFIG.UNITS.map((unit) => {
    try {
      return getUnitStatus(unit.name);
    } catch (err) {
      console.error(`[renderDashboard] Gagal menghitung status untuk "${unit.name}":`, err);
      return { statusKey: "servis", statusLabel: "Gagal Memuat Status", lastDate: null, nextDate: null };
    }
  });

  const cards = CONFIG.UNITS.map((unit, i) => {
    const s = statuses[i];
    const spek = [unit.merk, unit.pk].filter(Boolean).join(" · ");
    return `
      <div class="ac-card status-${s.statusKey}" data-unit="${unit.name}">
        <div class="flex items-start justify-between mb-3">
          <div class="flex items-center gap-2.5">
            <div class="w-10 h-10 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
              ${AC_ICON_SVG}
            </div>
            <div>
              <h3 class="font-bold text-[15px] leading-tight">${unit.name}</h3>
              ${spek ? `<p class="text-[11px] text-slate-400 leading-tight">${spek}</p>` : ""}
              <span class="status-pill mt-1">${s.statusLabel}</span>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2 text-xs mb-3">
          <div class="bg-slate-50 rounded-xl px-3 py-2">
            <p class="text-slate-400 mb-0.5">Servis Terakhir</p>
            <p class="font-semibold text-slate-700">${s.lastDate ? formatDateID(s.lastDate) : "-"}</p>
          </div>
          <div class="bg-slate-50 rounded-xl px-3 py-2">
            <p class="text-slate-400 mb-0.5">Servis Berikutnya</p>
            <p class="font-semibold text-slate-700">${s.nextDate ? formatDateID(s.nextDate) : "-"}</p>
          </div>
        </div>

        <div class="flex gap-2">
          <button class="card-action-btn bg-brand-50 text-brand-700 active:bg-brand-100" data-action="tambah-servis" data-unit="${unit.name}">
            + Catat Servis
          </button>
          <button class="card-action-btn bg-slate-100 text-slate-700 active:bg-slate-200" data-action="pengingat" data-unit="${unit.name}" ${!s.nextDate ? "disabled style=\"opacity:.5\"" : ""}>
            🔔 Pengingat
          </button>
        </div>
      </div>`;
  }).join("");

  el.dashboardCards.innerHTML = cards;

  const butuhServis = statuses.filter((s) => s.statusKey === "servis").length;
  el.summaryBadge.textContent = butuhServis > 0 ? `${butuhServis} unit perlu servis` : "Semua aman";
  el.summaryBadge.className = `text-[11px] font-semibold ${butuhServis > 0 ? "text-red-500" : "text-emerald-500"}`;
}

// ============================================================================
// RENDER: RIWAYAT
// ============================================================================
function renderRiwayat() {
  let records = allRecords
    .filter((r) => !isArchived(r))
    .sort((a, b) => parseDateStr(b.tanggalServis) - parseDateStr(a.tanggalServis));

  if (activeRiwayatFilter !== "Semua") {
    records = records.filter((r) => r.unitAC === activeRiwayatFilter);
  }

  if (records.length === 0) {
    el.riwayatList.innerHTML = `<p class="text-sm text-slate-400 text-center py-10">Belum ada riwayat servis${activeRiwayatFilter !== "Semua" ? " untuk unit ini" : ""}.</p>`;
    return;
  }

  el.riwayatList.innerHTML = records.map((r) => `
    <div class="riwayat-item">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="font-semibold text-sm">${escapeHtml(r.unitAC)}</p>
          <p class="text-xs text-slate-400 mt-0.5">${formatDateID(parseDateStr(r.tanggalServis))}${r.namaTeknisi ? " · " + escapeHtml(r.namaTeknisi) : ""}</p>
        </div>
        <div class="flex gap-1.5 shrink-0">
          <button class="riwayat-icon-btn" data-action="edit-riwayat" data-id="${escapeHtml(r.id)}" aria-label="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          </button>
          <button class="riwayat-icon-btn riwayat-icon-btn-danger" data-action="hapus-riwayat" data-id="${escapeHtml(r.id)}" aria-label="Hapus">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
          </button>
        </div>
      </div>
      ${r.catatan ? `<p class="text-xs text-slate-600 mt-2 leading-relaxed">${escapeHtml(r.catatan)}</p>` : ""}
    </div>
  `).join("");
}

function renderArsip() {
  const records = allRecords
    .filter((r) => isArchived(r))
    .sort((a, b) => parseDateStr(b.tanggalServis) - parseDateStr(a.tanggalServis));

  if (records.length === 0) {
    el.arsipList.innerHTML = `<p class="text-sm text-slate-400 text-center py-10">Belum ada riwayat yang diarsipkan.</p>`;
    return;
  }

  el.arsipList.innerHTML = records.map((r) => `
    <div class="riwayat-item riwayat-item-arsip">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="font-semibold text-sm">${escapeHtml(r.unitAC)}</p>
          <p class="text-xs text-slate-400 mt-0.5">${formatDateID(parseDateStr(r.tanggalServis))}${r.namaTeknisi ? " · " + escapeHtml(r.namaTeknisi) : ""}</p>
        </div>
        <button class="restore-btn shrink-0" data-action="pulihkan-riwayat" data-id="${escapeHtml(r.id)}">
          Pulihkan
        </button>
      </div>
      ${r.catatan ? `<p class="text-xs text-slate-600 mt-2 leading-relaxed">${escapeHtml(r.catatan)}</p>` : ""}
    </div>
  `).join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderAll() {
  renderDashboard();
  renderRiwayat();
  renderArsip();
}

// ============================================================================
// TAB NAVIGATION
// ============================================================================
function switchTab(tabId) {
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("hidden", panel.id !== tabId));
  $$(".nav-btn").forEach((btn) => btn.classList.toggle("nav-btn-active", btn.dataset.tab === tabId));
}

$$(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// ============================================================================
// MODAL: TAMBAH SERVIS
// ============================================================================
/** Buka modal dalam mode TAMBAH baru (opsional: unit AC sudah dipilihkan). */
function openServisModal(prefillUnit) {
  editingRecordId = null;
  el.formServis.reset();
  $("#input-tanggal").value = toDateStr(new Date());
  if (prefillUnit) $("#input-unit").value = prefillUnit;
  el.modalServisTitle.textContent = "Catat Servis Baru";
  el.btnSubmitLabel.textContent = "Simpan";
  el.modalServis.classList.remove("hidden");
}

/** Buka modal dalam mode EDIT, terisi otomatis dari data record yang sudah ada. */
function openEditModal(record) {
  editingRecordId = record.id;
  el.formServis.reset();
  $("#input-unit").value = record.unitAC;
  $("#input-tanggal").value = record.tanggalServis;
  $("#input-teknisi").value = record.namaTeknisi || "";
  $("#input-catatan").value = record.catatan || "";
  el.modalServisTitle.textContent = "Edit Servis";
  el.btnSubmitLabel.textContent = "Simpan Perubahan";
  el.modalServis.classList.remove("hidden");
}

function closeServisModal() {
  el.modalServis.classList.add("hidden");
  editingRecordId = null;
}

el.btnFab.addEventListener("click", () => openServisModal());
$$("[data-close-modal]").forEach((elx) => elx.addEventListener("click", closeServisModal));

// ============================================================================
// MODAL: KONFIRMASI (generik, dipakai untuk konfirmasi Hapus)
// ============================================================================
function openConfirmModal(title, message, onConfirm) {
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  confirmCallback = onConfirm;
  el.modalConfirm.classList.remove("hidden");
}

function closeConfirmModal() {
  el.modalConfirm.classList.add("hidden");
  confirmCallback = null;
}

el.btnConfirmYes.addEventListener("click", async () => {
  const callback = confirmCallback;
  closeConfirmModal();
  if (typeof callback === "function") await callback();
});

$$("[data-close-confirm]").forEach((elx) => elx.addEventListener("click", closeConfirmModal));

// ============================================================================
// RIWAYAT: EDIT & HAPUS (event delegation)
// ============================================================================
el.riwayatList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  const record = allRecords.find((r) => String(r.id) === String(id));
  if (!record) return;

  if (btn.dataset.action === "edit-riwayat") {
    openEditModal(record);
  } else if (btn.dataset.action === "hapus-riwayat") {
    openConfirmModal(
      "Hapus Riwayat",
      `Hapus riwayat servis "${record.unitAC}" tanggal ${formatDateID(parseDateStr(record.tanggalServis))}? Data akan dipindah ke Arsip dan bisa dipulihkan kapan saja.`,
      async () => {
        setLoading(true);
        const ok = await archiveRecord(id);
        setLoading(false);
        if (ok) {
          showToast("Riwayat dipindahkan ke Arsip ✓", "success");
          await fetchServiceData();
        }
      }
    );
  }
});

// ============================================================================
// ARSIP: PULIHKAN (event delegation)
// ============================================================================
el.arsipList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  const record = allRecords.find((r) => String(r.id) === String(id));
  if (!record) return;

  if (btn.dataset.action === "pulihkan-riwayat") {
    openConfirmModal(
      "Pulihkan Riwayat",
      `Pulihkan riwayat servis "${record.unitAC}" tanggal ${formatDateID(parseDateStr(record.tanggalServis))} ke daftar Riwayat aktif?`,
      async () => {
        setLoading(true);
        const ok = await restoreRecord(id);
        setLoading(false);
        if (ok) {
          showToast("Riwayat berhasil dipulihkan ✓", "success");
          await fetchServiceData();
        }
      }
    );
  }
});

el.formServis.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(el.formServis);
  const isEdit = !!editingRecordId;
  const payload = {
    action: isEdit ? "update" : "create",
    unitAC: formData.get("unitAC"),
    tanggalServis: formData.get("tanggalServis"),
    namaTeknisi: formData.get("namaTeknisi") || "",
    catatan: formData.get("catatan") || ""
  };
  if (isEdit) payload.id = editingRecordId;

  if (!payload.unitAC || !payload.tanggalServis) {
    showToast("Unit AC dan Tanggal Servis wajib diisi.", "error");
    return;
  }

  el.btnSubmitServis.disabled = true;
  setLoading(true);

  const ok = await submitServiceRecord(payload);

  setLoading(false);
  el.btnSubmitServis.disabled = false;

  if (ok) {
    closeServisModal();
    showToast(isEdit ? "Perubahan berhasil disimpan ✓" : "Servis berhasil dicatat ✓", "success");
    await fetchServiceData();
  }
});

// ============================================================================
// DASHBOARD CARD ACTIONS (event delegation)
// ============================================================================
el.dashboardCards.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const unit = btn.dataset.unit;

  if (btn.dataset.action === "tambah-servis") {
    openServisModal(unit);
  } else if (btn.dataset.action === "pengingat") {
    const s = getUnitStatus(unit);
    if (s.nextDate) openKalenderModal(unit, s.nextDate);
  }
});

// ============================================================================
// MODAL: PENGINGAT KALENDER
// ============================================================================
function openKalenderModal(unit, nextDate) {
  activeKalenderContext = { unit, nextDate };
  el.kalenderInfo.textContent = `${unit} — jadwal servis berikutnya: ${formatDateID(nextDate)}`;
  el.modalKalender.classList.remove("hidden");
}

function closeKalenderModal() {
  el.modalKalender.classList.add("hidden");
  activeKalenderContext = null;
}

$$("[data-close-kalender]").forEach((elx) => elx.addEventListener("click", closeKalenderModal));

function buildGoogleCalendarUrl(unit, nextDate) {
  const start = new Date(nextDate);
  const end = new Date(nextDate.getTime() + CONFIG.CALENDAR_EVENT_DURATION_MINUTES * 60000);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `Servis ${unit}`,
    dates: `${fmt(start)}/${fmt(end)}`,
    details: `Pengingat jadwal servis berkala untuk ${unit}. Dibuat otomatis oleh aplikasi Manajemen Servis AC Rumah.`,
    location: "Rumah"
  });

  return `https://www.google.com/calendar/render?${params.toString()}`;
}

function buildIcsContent(unit, nextDate) {
  const start = new Date(nextDate);
  const end = new Date(nextDate.getTime() + CONFIG.CALENDAR_EVENT_DURATION_MINUTES * 60000);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const uid = `servis-ac-${unit.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}@manajemen-servis-ac`;

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Manajemen Servis AC Rumah//ID",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:Servis ${unit}`,
    `DESCRIPTION:Pengingat jadwal servis berkala untuk ${unit}.`,
    "LOCATION:Rumah",
    "BEGIN:VALARM",
    "TRIGGER:-P1D",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");
}

el.btnAddGoogleCalendar.addEventListener("click", () => {
  if (!activeKalenderContext) return;
  const { unit, nextDate } = activeKalenderContext;
  window.open(buildGoogleCalendarUrl(unit, nextDate), "_blank");
});

el.btnDownloadIcs.addEventListener("click", () => {
  if (!activeKalenderContext) return;
  const { unit, nextDate } = activeKalenderContext;
  const ics = buildIcsContent(unit, nextDate);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Servis-${unit.replace(/\s+/g, "-")}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("File .ics diunduh — buka untuk menambah ke Kalender", "success");
});

// ============================================================================
// FILTER RIWAYAT
// ============================================================================
el.riwayatFilter.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-filter]");
  if (!chip) return;
  activeRiwayatFilter = chip.dataset.filter;
  $$(".filter-chip").forEach((c) => c.classList.toggle("filter-chip-active", c === chip));
  renderRiwayat();
});

// ============================================================================
// EXPORT PDF
// ============================================================================
el.btnExportPdf.addEventListener("click", async () => {
  let records = allRecords
    .filter((r) => !isArchived(r))
    .sort((a, b) => parseDateStr(b.tanggalServis) - parseDateStr(a.tanggalServis));
  if (activeRiwayatFilter !== "Semua") {
    records = records.filter((r) => r.unitAC === activeRiwayatFilter);
  }

  if (records.length === 0) {
    showToast("Tidak ada data riwayat untuk diexport.", "error");
    return;
  }

  const rows = records.map((r, i) => `
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:8px 6px;font-size:11px;">${i + 1}</td>
      <td style="padding:8px 6px;font-size:11px;">${r.unitAC}</td>
      <td style="padding:8px 6px;font-size:11px;">${formatDateID(parseDateStr(r.tanggalServis))}</td>
      <td style="padding:8px 6px;font-size:11px;">${escapeHtml(r.namaTeknisi || "-")}</td>
      <td style="padding:8px 6px;font-size:11px;">${escapeHtml(r.catatan || "-")}</td>
    </tr>`).join("");

  el.pdfTemplate.innerHTML = `
    <div style="padding:28px;">
      <h1 style="font-size:20px;margin:0 0 2px;">Laporan Riwayat Servis AC Rumah</h1>
      <p style="font-size:11px;color:#64748b;margin:0 0 18px;">
        Filter: ${activeRiwayatFilter} · Dicetak: ${formatDateID(new Date())}
      </p>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#2563eb;color:#fff;">
            <th style="padding:8px 6px;text-align:left;font-size:11px;">No</th>
            <th style="padding:8px 6px;text-align:left;font-size:11px;">Unit AC</th>
            <th style="padding:8px 6px;text-align:left;font-size:11px;">Tanggal Servis</th>
            <th style="padding:8px 6px;text-align:left;font-size:11px;">Teknisi</th>
            <th style="padding:8px 6px;text-align:left;font-size:11px;">Catatan</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  showToast("Membuat PDF…", "info");

  const opt = {
    margin: 0,
    filename: `Riwayat-Servis-AC-${toDateStr(new Date())}.pdf`,
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
  };

  // PENTING (dua lapis, keduanya WAJIB, sudah diuji langsung — pernah gagal
  // total sebelum ini):
  // 1) Elemen ini punya class "hidden" (display:none) di index.html supaya
  //    tidak pernah kelihatan di UI biasa. html2canvas (dipakai html2pdf.js)
  //    TIDAK BISA merender elemen display:none sama sekali -> class "hidden"
  //    WAJIB dilepas sesaat sebelum render, lalu dipasang lagi setelah selesai.
  // 2) style.css SENGAJA tidak lagi memakai trik "posisi di luar layar"
  //    (position:fixed/absolute + left:-9999px) untuk elemen ini — html2canvas
  //    TERBUKTI GAGAL merender elemen yang diposisikan begitu (hasilnya PDF
  //    halaman kosong, walau ukuran file-nya terlihat normal). Elemen ini
  //    sekarang dirender pada posisi normal (in-flow) dan disembunyikan dari
  //    pandangan pengguna dengan cara lain: #loading-overlay (setLoading(true))
  //    menutupi SELURUH layar tepat sebelum class "hidden" dilepas.
  setLoading(true);
  el.pdfTemplate.classList.remove("hidden");

  try {
    // Beri browser satu frame untuk benar-benar melayout & mengecat ulang
    // konten yang baru saja dimasukkan sebelum html2canvas mengambil snapshot-nya.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await html2pdf().set(opt).from(el.pdfTemplate).save();
  } catch (err) {
    console.error(err);
    showToast("Gagal membuat PDF: " + err.message, "error");
  } finally {
    el.pdfTemplate.classList.add("hidden");
    setLoading(false);
  }
});

// ============================================================================
// REFRESH & ONLINE/OFFLINE
// ============================================================================
el.btnRefresh.addEventListener("click", async () => {
  el.refreshIcon.classList.add("spinning");
  await fetchServiceData();
  setTimeout(() => el.refreshIcon.classList.remove("spinning"), 400);
});

window.addEventListener("online", () => {
  el.offlineBanner.classList.add("hidden");
  fetchServiceData();
});
window.addEventListener("offline", () => {
  el.offlineBanner.classList.remove("hidden");
});

// ============================================================================
// SERVICE WORKER
// ============================================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((err) => {
      console.warn("[SW] Registrasi gagal:", err);
    });
  });
}

// ============================================================================
// INIT
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
  if (!navigator.onLine) el.offlineBanner.classList.remove("hidden");
  fetchServiceData();
});
