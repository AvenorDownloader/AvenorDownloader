/// <reference path="types/window.d.ts" />

import { t as TT, LANG, type LangKey } from "./ui/lang.js";

// === License model (из main/licenseService) ===
type LicensePlanId = "free" | "pro_month" | "pro" | "pro_year";

type License = {
  plan: LicensePlanId;
  isPro: boolean;
  expiresAt: string | null;
  lastCheckedAt?: string | null;

  // то, что приходит/уходит через Supabase / license.json
  email?: string | null;
  proUntil?: string | null;
};

type AvenorApi = {
  addJob: (p: any) => Promise<string>;
  addCompressJob: (p: any) => Promise<string>;
  addConvertJob: (p: any) => Promise<string>; // ← добавь
  onProgress: (cb: (p: any) => void) => void | (() => void);
  revealInFolder: (filePath: string) => Promise<boolean>;
  pickFolder: () => Promise<string | null>;
  cancelJob?: (id: string) => Promise<boolean>;
  removeJob?: (id: string) => Promise<boolean>;

  // ▼ LICENSE
  getLicense?: () => Promise<License>;
  setLicense?: (partial: Partial<License>) => Promise<License>;

  // ▼ APP
  openExternal?: (url: string) => Promise<boolean | void>;

  checkUpdates?: () => Promise<any>;
  installUpdate?: () => Promise<void>;
};

function safePath(ofFile: any): string | null {
  const p = (ofFile as { path?: string } | null | undefined)?.path;
  return typeof p === "string" && p.length > 0 ? p : null;
}

const AvenorAPI: AvenorApi = (window as any).Avenor; // ← важно: Avenor, не AvenorAPI

// ==== PRO-логика: лимиты бесплатной версии ====

type ProUsageKind = "download" | "compress" | "convert";

type ProUsageState = {
  day: string; // YYYY-MM-DD
  downloads: number;
  compress: number;
  convert: number;
};

const PRO_LIMITS = {
  DOWNLOADS_PER_DAY_FREE: 10,
  MAX_FILE_MB_FREE: 500,
  COMPRESS_PER_DAY_FREE: 3,
  CONVERT_PER_DAY_FREE: 3,
} as const;

const PRO_USAGE_KEY = "avenor_pro_usage_v1";

// Глобальный флаг PRO (используется лимитами)
let IS_PRO = false;

// Текущее состояние лицензии, которое приходит из main/licenseService
let CURRENT_LICENSE: License | null = null;

function applyLicenseToUi(lic: License | null) {
  const body = document.body;
  const badgeTop = document.getElementById(
    "user-plan-badge"
  ) as HTMLSpanElement | null;
  const badgeSettings = document.getElementById(
    "settings-plan-badge"
  ) as HTMLSpanElement | null;

  const isPro = !!lic?.isPro;

  IS_PRO = isPro; // синхронизация с лимитами FREE/PRO

  body.classList.toggle("user-pro", isPro);
  body.classList.toggle("user-free", !isPro);

  const baseLabel = isPro ? "PRO" : "Free";

  if (badgeTop) {
    badgeTop.textContent = baseLabel;
  }

  if (badgeSettings) {
    if (isPro && lic?.expiresAt) {
      const d = new Date(lic.expiresAt);
      const dateStr = d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      badgeSettings.textContent = `${baseLabel} до ${dateStr}`;
    } else {
      badgeSettings.textContent = baseLabel;
    }
  }

  // обновляем индикатор лимитов
  updateFreeUsageBar();
}

function todayKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function loadProUsage(): ProUsageState {
  try {
    const raw = window.localStorage.getItem(PRO_USAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ProUsageState;
      // если день другой — обнуляем счётчики
      if (parsed.day === todayKey()) return parsed;
    }
  } catch {}
  return {
    day: todayKey(),
    downloads: 0,
    compress: 0,
    convert: 0,
  };
}

let PRO_USAGE: ProUsageState = loadProUsage();

function updateFreeUsageBar() {
  // один и тот же стейт, три разные полосы
  const bars: {
    wrap: HTMLDivElement | null;
    used: number;
    max: number;
  }[] = [
    {
      // вкладка "Скачать"
      wrap: document.getElementById("free-limit-bar") as HTMLDivElement | null,
      used: PRO_USAGE.downloads,
      max: PRO_LIMITS.DOWNLOADS_PER_DAY_FREE,
    },
    {
      // вкладка "Сжать"
      wrap: document.getElementById(
        "free-limit-bar-compress"
      ) as HTMLDivElement | null,
      used: PRO_USAGE.compress,
      max: PRO_LIMITS.COMPRESS_PER_DAY_FREE,
    },
    {
      // вкладка "Конвертировать"
      wrap: document.getElementById(
        "free-limit-bar-convert"
      ) as HTMLDivElement | null,
      used: PRO_USAGE.convert,
      max: PRO_LIMITS.CONVERT_PER_DAY_FREE,
    },
  ];

  for (const entry of bars) {
    const wrap = entry.wrap;
    if (!wrap) continue;
    const fill = wrap.querySelector(
      ".free-limit-fill"
    ) as HTMLDivElement | null;
    if (!fill) continue;

    // PRO-план — все полосы скрываем
    if (IS_PRO) {
      wrap.style.display = "none";
      continue;
    }

    wrap.style.display = "";

    const max = entry.max;
    const used = Math.max(0, Math.min(entry.used, max));
    const ratio = max > 0 ? used / max : 0;
    const percent = Math.max(0, Math.min(100, ratio * 100));

    const remaining = Math.max(0, max - used);

    // цвет: зелёный → жёлтый → оранжевый → красный
    let color = "#92d83c"; // зелёный Avenor
    if (remaining <= 0) {
      color = "#ff3b3b"; // лимит выбит
    } else if (ratio >= 0.8) {
      color = "#ff7a3c"; // почти всё истрачено
    } else if (ratio >= 0.5) {
      color = "#ffd24d"; // больше половины лимита
    }

    fill.style.width = `${percent}%`;
    fill.style.background = color;
  }
}



function saveProUsage() {
  try {
    window.localStorage.setItem(PRO_USAGE_KEY, JSON.stringify(PRO_USAGE));
  } catch {}
}

function noteProUsage(kind: ProUsageKind) {
  if (IS_PRO) return; // PRO-пользователей не ограничиваем и не считаем

  const today = todayKey();
  if (PRO_USAGE.day !== today) {
    PRO_USAGE = {
      day: today,
      downloads: 0,
      compress: 0,
      convert: 0,
    };
  }

  if (kind === "download") PRO_USAGE.downloads++;
  if (kind === "compress") PRO_USAGE.compress++;
  if (kind === "convert") PRO_USAGE.convert++;

  saveProUsage();
  updateFreeUsageBar(); // ← обновляем полоску
}

// Показываем paywall, когда пользователь упирается в лимит
function showProPaywall(reason: string) {
  const overlay = document.getElementById(
    "pro-overlay"
  ) as HTMLDivElement | null;
  const reasonEl = document.getElementById(
    "pro-reason"
  ) as HTMLParagraphElement | null;

  if (reasonEl) reasonEl.textContent = reason;
  if (!overlay) {
    alert(reason); // fallback, если разметка не нашлась
    return;
  }

  overlay.classList.add("visible");
  overlay.setAttribute("aria-hidden", "false");
}

// Скрыть paywall
function hideProPaywall() {
  const overlay = document.getElementById(
    "pro-overlay"
  ) as HTMLDivElement | null;
  if (!overlay) return;
  overlay.classList.remove("visible");
  overlay.setAttribute("aria-hidden", "true");
}

// Проверка лимитов FREE. Ничего не считает, только решает "можно" / "нельзя".
function ensureFreeLimit(opts: {
  kind: ProUsageKind;
  quality?: QualityKey | null;
  fileBytes?: number | null;
}): boolean {
  if (IS_PRO) return true;

  const { kind, quality, fileBytes } = opts;
  const sizeMB = fileBytes != null ? fileBytes / (1024 * 1024) : null;

  // Обновляем день (но без инкремента)
  const today = todayKey();
  if (PRO_USAGE.day !== today) {
    PRO_USAGE = {
      day: today,
      downloads: 0,
      compress: 0,
      convert: 0,
    };
    saveProUsage();
    updateFreeUsageBar(); // ← обнулили счётчик в UI
  }

  if (kind === "download") {
    // 2K / 4K / 8K — только PRO
    if (quality === "2k" || quality === "4k" || quality === "8k") {
      showProPaywall("Качество 2K / 4K / 8K доступно только в Avenor PRO.");
      return false;
    }

    if (PRO_USAGE.downloads >= PRO_LIMITS.DOWNLOADS_PER_DAY_FREE) {
      showProPaywall(
        "В бесплатной версии доступно до 10 загрузок в день. Откройте Avenor PRO, чтобы снимать лимит."
      );
      return false;
    }
  }

  if (kind === "compress" || kind === "convert") {
    if (sizeMB != null && sizeMB > PRO_LIMITS.MAX_FILE_MB_FREE) {
      showProPaywall("Файлы больше 500 МБ доступны только в Avenor PRO.");
      return false;
    }

    const used = kind === "compress" ? PRO_USAGE.compress : PRO_USAGE.convert;
    const max =
      kind === "compress"
        ? PRO_LIMITS.COMPRESS_PER_DAY_FREE
        : PRO_LIMITS.CONVERT_PER_DAY_FREE;

    if (used >= max) {
      const verb = kind === "compress" ? "сжатий" : "конвертаций";
      showProPaywall(
        `В бесплатной версии доступно до ${max} ${verb} в день. Откройте Avenor PRO, чтобы продолжить без ограничений.`
      );
      return false;
    }
  }

  return true;
}

// Инициализация кнопок в paywall (Купить / Закрыть)
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById(
    "pro-close-btn"
  ) as HTMLButtonElement | null;
  const overlay = document.getElementById(
    "pro-overlay"
  ) as HTMLDivElement | null;
  const buyBtn = document.getElementById(
    "pro-buy-btn"
  ) as HTMLButtonElement | null;

  closeBtn?.addEventListener("click", () => hideProPaywall());
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) hideProPaywall();
  });

  buyBtn?.addEventListener("click", () => {
    // если в настройках введён email — подставим его в URL
    const emailInput = document.getElementById(
      "settings-email"
    ) as HTMLInputElement | null;

    const email = emailInput?.value.trim();
    const baseUrl = "https://avenor.app/pro"; // TODO: твоя реальная страница оплаты / Paddle checkout

    const url = email
      ? `${baseUrl}?email=${encodeURIComponent(email)}`
      : baseUrl;

    // пробуем через мост к main (если сделаешь Avenor.openExternal)
    try {
      (window as any).Avenor?.openExternal?.(url);
    } catch {}

    // и на всякий случай — стандартное открытие в браузере
    try {
      window.open(url, "_blank");
    } catch {}

    console.log("[PRO] Open checkout:", url);
  });
});

// ==== PRO / профиль пользователя ====

type PlanId = "free" | "pro";

type UserProfile = {
  email: string;
  plan: PlanId;
  isPro: boolean;
  proUntil: string | null;
};

const PROFILE_STORAGE_KEY = "avenor_profile_v1";

const proState = {
  profile: null as UserProfile | null,

  get isPro() {
    return !!this.profile?.isPro;
  },

  get planLabel() {
    if (!this.profile) return "Free";
    return this.profile.isPro ? "PRO" : "Free";
  },
};

function isLicenseActive(
  lic: {
    isPro?: boolean;
    proUntil?: string | null;
    expiresAt?: string | null;
  } | null
): boolean {
  if (!lic || !lic.isPro) return false;

  // поддерживаем оба варианта: proUntil (renderer) и expiresAt (licenseService)
  const untilStr = lic.proUntil ?? lic.expiresAt;
  if (!untilStr) return true; // бессрочная PRO

  const now = Date.now();
  const till = Date.parse(untilStr);
  if (!Number.isFinite(till)) return false;
  return till > now;
}

function shouldRefreshLicense(lic: any): boolean {
  if (!lic || !lic.email) return false;

  const now = Date.now();
  const last = lic.lastCheckedAt ? Date.parse(lic.lastCheckedAt) : 0;
  const ONE_DAY = 24 * 60 * 60 * 1000;

  // если никогда не проверяли или прошло больше суток — обновляем
  if (!last || !Number.isFinite(last)) return true;
  return now - last > ONE_DAY;
}

function saveProfileLocally(profile: UserProfile | null) {
  if (!profile) {
    window.localStorage.removeItem(PROFILE_STORAGE_KEY);
    return;
  }
  try {
    window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch (e) {
    console.warn("[profile] save error", e);
  }
}

function loadProfileFromStorage(): UserProfile | null {
  try {
    const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);

    if (!data.email) return null;

    return {
      email: String(data.email),
      plan: data.plan === "pro" ? "pro" : "free",
      isPro: !!data.isPro,
      proUntil: data.proUntil ?? null,
    };
  } catch {
    return null;
  }
}

function applyProfileToUI() {
  const body = document.body;
  const badgeTop = document.getElementById(
    "user-plan-badge"
  ) as HTMLSpanElement | null;
  const badgeSettings = document.getElementById(
    "settings-plan-badge"
  ) as HTMLSpanElement | null;

  if (proState.isPro) {
    body.classList.add("user-pro");
    body.classList.remove("user-free");
  } else {
    body.classList.add("user-free");
    body.classList.remove("user-pro");
  }

  const label = proState.planLabel;

  if (badgeTop) badgeTop.textContent = label;
  if (badgeSettings) badgeSettings.textContent = label;

  // важное место: синхронизируем глобальный флаг для лимитов
  IS_PRO = proState.isPro;
  updateFreeUsageBar(); // ← показываем/прячем индикатор в зависимости от плана
}

// TODO: сюда потом поставим реальный URL Supabase/Paddle
async function fetchProfileFromBackend(
  email: string
): Promise<UserProfile | null> {
  // 1) Правильный URL edge-функции
  const url =
    "https://yyyzviatxbwlfdfbbimf.supabase.co/functions/v1/check-license";

  // 2) Анонимный ключ проекта (Settings → API → Project API keys → anon public)
  // ВСТАВЬ СВОЙ ЗНАЧЕНИЕ СЮДА:
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl5eXp2aWF0eGJ3bGZkZmJiaW1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQxMDY4NzYsImV4cCI6MjA3OTY4Mjg3Nn0.IkbMpy1G1vX3Y6KeLLjZGSsAi3qja6bz6V5Cbg_IEVQ";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",

      // тот же ключ, что и AVENOR_LICENSE_API_KEY в edge-функции
      "x-avenor-key": "supersecret123XYZ",

      // ВАЖНО: JWT для Verify JWT в Supabase Edge Functions
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ email }),
  });

  if (!res.ok) {
    console.error("[profile] request failed", res.status, await res.text());
    throw new Error("Profile request failed");
  }

  const data = await res.json();

  const profile: UserProfile = {
    email: data.email,
    plan: data.plan === "pro" ? "pro" : "free",
    isPro: !!data.is_pro,
    proUntil: data.pro_until ?? null,
  };

  return profile;
}

let DL_FILTER: "all" | "video" | "audio" = "all";
let DL_SORT: "date" | "name" = "date";
let DL_DIR: "asc" | "desc" = "desc";

// какие настройки были у задачи (для PRO-логики BEST + 4K)
const JOB_QUALITY = new Map<string, QualityKey>();
const JOB_KIND = new Map<string, "video" | "audio">();

// Отдельные настройки для вкладки "Сжать"
let CMP_FILTER: "all" | "video" | "audio" = "all";
let CMP_SORT: "date" | "name" = "date";
let CMP_DIR: "asc" | "desc" = "desc";

// Отдельные настройки для вкладки "Конвертировать"
let CNV_FILTER: "all" | "video" | "audio" = "all";
let CNV_SORT: "date" | "name" = "date";
let CNV_DIR: "asc" | "desc" = "desc";

// Проверяем расширение на аудио, чтобы подставлять иконку
function isAudioExtName(ext: unknown): boolean {
  if (typeof ext !== "string") return false;
  const e = ext.toLowerCase();
  return ["mp3", "wav", "aac", "m4a", "flac", "ogg", "opus"].includes(e);
}

function applyThumb(
  img: HTMLImageElement | null,
  meta: any,
  historyItem?: any
) {
  if (!img) return;

  const src =
    historyItem?.thumb || // ← берём из HistoryItem
    meta?.thumb ||
    meta?.thumbnail ||
    meta?.thumbUrl ||
    meta?.preview ||
    meta?.previewUrl;

  const isAudio =
    historyItem?.kind === "audio" ||
    isAudioExtName(meta?.ext) ||
    (!!meta?.acodec && !meta?.vcodec && !meta?.resolution);

  // --- АУДИО: всегда показываем наш фон, без src ---
  if (isAudio) {
    img.removeAttribute("src");
    img.classList.add("thumb--audio");

    // убираем заглушку и лоадер
    img.classList.remove("thumb--ph", "thumb--loading");
    const wrap = img.closest(".thumb-wrap") as HTMLElement | null;
    wrap?.classList.remove("thumb-wrap--loading");

    return;
  }

  // --- ВИДЕО: если есть нормальный thumbnail — ставим его ---
  if (src && img.src !== src) {
    img.src = src;

    // снимаем заглушку/лоадер, раз превью появилось
    img.classList.remove("thumb--ph", "thumb--loading");
    const wrap = img.closest(".thumb-wrap") as HTMLElement | null;
    wrap?.classList.remove("thumb-wrap--loading");

    return;
  }

  // сюда попадаем, если нет ни превью, ни аудио-режима
  // оставляем thumb--ph как есть — будет стандартная заглушка
}

function syncSortMenu() {
  if (!sortMenu) return;
  // поле сортировки
  sortMenu
    .querySelectorAll<HTMLElement>(".sort-opt[data-sort]")
    .forEach((o) => {
      o.toggleAttribute("aria-selected", (o.dataset.sort as any) === DL_SORT);
    });
  // направление
  sortMenu.querySelectorAll<HTMLElement>(".sort-opt[data-dir]").forEach((o) => {
    o.toggleAttribute("aria-selected", (o.dataset.dir as any) === DL_DIR);
  });
}

function syncSortMenuCompress() {
  if (!sortMenuCompress) return;
  // поле сортировки
  sortMenuCompress
    .querySelectorAll<HTMLElement>(".sort-opt[data-sort]")
    .forEach((o) => {
      o.toggleAttribute("aria-selected", (o.dataset.sort as any) === CMP_SORT);
    });
  // направление
  sortMenuCompress
    .querySelectorAll<HTMLElement>(".sort-opt[data-dir]")
    .forEach((o) => {
      o.toggleAttribute("aria-selected", (o.dataset.dir as any) === CMP_DIR);
    });
}

function syncSortMenuConvert() {
  if (!sortMenuConvert) return;
  // поле сортировки
  sortMenuConvert
    .querySelectorAll<HTMLElement>(".sort-opt[data-sort]")
    .forEach((o) => {
      o.toggleAttribute("aria-selected", (o.dataset.sort as any) === CNV_SORT);
    });
  // направление
  sortMenuConvert
    .querySelectorAll<HTMLElement>(".sort-opt[data-dir]")
    .forEach((o) => {
      o.toggleAttribute("aria-selected", (o.dataset.dir as any) === CNV_DIR);
    });
}

// Локальные типы — без импортов, чтобы файл не компилился как модуль
type QualityKey =
  | "best"
  | "8k"
  | "4k"
  | "2k"
  | "1080p"
  | "720p"
  | "480p"
  | "360p"
  | "240p"
  | "audio";

type AddJobPayload = {
  url: string;
  type: "video" | "audio";
  quality: QualityKey;
  outDir?: string;
};
type JobProgress = {
  id: string;
  stage:
    | "preparing"
    | "probe"
    | "pass1"
    | "pass2"
    | "encoding"
    | "compressing"
    | "downloading"
    | "merging"
    | "post"
    | "done"
    | "error"
    | "canceled";
  percent?: number;
  downloadedMB?: number;
  totalMB?: number;
  speed?: string;
  eta?: string;
  filepath?: string;
  message?: string;
  meta?: {
    title?: string;
    ext?: string;
    vcodec?: string;
    acodec?: string;
    resolution?: string;
    fps?: number;
    durationSec?: number;
    sizeMB?: number;
    date?: string;
    thumbnail?: string;
  };
};

const pasteBtn = document.getElementById("pasteBtn") as HTMLButtonElement;
const pickFolderBtn = document.getElementById(
  "pickFolder"
) as HTMLButtonElement;
const savePathSpan = document.getElementById("savePath") as HTMLSpanElement;
const qualitySel = document.getElementById("quality") as HTMLSelectElement;

// вкладки/панели
const tabDownload = document.getElementById(
  "tab-download"
) as HTMLButtonElement;
const tabCompress = document.getElementById(
  "tab-compress"
) as HTMLButtonElement;
const panelDownload = document.getElementById("panel-download")!;
const panelCompress = document.getElementById("panel-compress")!;

let SETTINGS_STATE: any = null;
let CURRENT_LANG: LangKey = "ru";
let doneAudioEl: HTMLAudioElement | null = null;
const tr = (path: string) => TT(CURRENT_LANG, path);

let SFX = { done: "", error: "" };
(async () => {
  try {
    const api: any = (window as any).Avenor;
    SFX.done = await api.getAssetUrl("sfx/done.wav");
    SFX.error = await api.getAssetUrl("sfx/error.wav");
  } catch (e) {
    console.warn("[renderer] sfx preload failed", e);
  }
})();

type HistoryItem = {
  id: string;
  ts: number;
  source?: "download" | "compress" | "convert";
  kind?: "video" | "audio" | "other";
  stage: JobProgress["stage"];
  meta?: JobProgress["meta"];
  filepath?: string;
  title?: string;
  thumb?: string; // ← превью, которое мы сохранили в history.json
};

async function renderHistoryOnStartup() {
  const items: HistoryItem[] = await (window as any).Avenor.getHistory();
  if (!items || !items.length) {
    (window as any).AvenorUI?.refreshEmptyState?.();
    return;
  }

  for (const h of items) {
    const list =
      h.source === "compress"
        ? listCompress
        : h.source === "convert"
        ? (document.getElementById("list-convert") as HTMLElement | null)
        : listDownload;

    const card = document.createElement("div");
    card.className = "card job-card";
    card.id = `job-${h.id}`;
    (card as any).dataset.jobId = h.id;
    (card as any).dataset.ts = String(h.ts);
    (card as any).dataset.kind = h.kind || "other";
    (card as any).dataset.jobType = h.source || "download";

    card.innerHTML = `
      <div class="dl-grid">
        <div class="thumb-wrap"><img class="thumb thumb--ph" alt=""></div>
        <div class="content">
          <div class="title" title=""></div>
          <div class="progress"><div></div></div>
          <div class="meta"></div>
        </div>
        <div class="actions">
          <button class="icon-btn" data-cancel title="Отменить" aria-label="Отменить" style="display:none">
            <svg viewBox="0 0 24 24" class="icon"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
          </button>
          <button class="icon-btn" data-delete title="Удалить" aria-label="Удалить">
            <svg viewBox="0 0 24 24" class="icon"><path d="M9 3h6m-8 4h10m-1 0l-1 13H9L8 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="action" data-open>Открыть в папке</div>
        </div>
      </div>
    `;
    // превью из истории / meta
    const thumbEl = card.querySelector(".thumb") as HTMLImageElement | null;
    applyThumb(thumbEl, h.meta, h); // ← ставим src
    if (thumbEl && thumbEl.src) {
      thumbEl.classList.remove("thumb--ph");
      (thumbEl as any).dataset.set = "1";
    }

    // заголовок
    const titleEl = card.querySelector(".title") as HTMLDivElement;
    applyTitle(titleEl, h.title || h.meta?.title, h.filepath);

    // статусная строка — для 'done' показываем мету красиво
    const metaEl = card.querySelector(".meta") as HTMLDivElement;
    if (h.stage === "done") {
      const parts: string[] = ["Готово"];
      if (h.meta?.resolution)
        parts.push(h.meta.resolution.toUpperCase().replace("X", "x"));
      if (h.meta?.fps) parts.push(`${h.meta.fps} FPS`);
      if (h.meta?.durationSec) {
        const m = Math.floor(h.meta.durationSec / 60);
        const s = String(Math.floor(h.meta.durationSec % 60)).padStart(2, "0");
        parts.push(`${m}:${s}`);
      }
      if (h.meta?.sizeMB) parts.push(`${h.meta.sizeMB.toFixed(1)} MB`);
      if (h.meta?.ext) parts.push(h.meta.ext.toUpperCase());
      metaEl.textContent = parts.join(" • ");
      card.classList.add("done");
      (card.querySelector(".progress") as HTMLElement).style.display = "none";
    } else {
      metaEl.textContent = "Статус: " + mapStage(h.stage, h.source);
    }

    // кнопка «Открыть в папке»
    const openBtn = card.querySelector("[data-open]") as HTMLElement;
    if (h.filepath) {
      (card as any).dataset.filepath = h.filepath;
      openBtn.onclick = () => AvenorAPI.revealInFolder(h.filepath!);
    } else {
      openBtn.setAttribute("aria-disabled", "true");
      openBtn.style.pointerEvents = "none";
      openBtn.style.opacity = "0.6";
    }

    // удаление из истории (только UI + запись)
    const deleteBtn = card.querySelector("[data-delete]") as HTMLButtonElement;
    deleteBtn.onclick = async () => {
      await (window as any).Avenor.historyRemove(h.id).catch(() => {});
      card.remove();
      try {
        (window as any).AvenorUI?.refreshEmptyState?.();
      } catch {}
    };

    (list || listDownload).appendChild(card);
  }

  refreshDownloadListView();
  try {
    refreshCompressListView();
  } catch {}
  try {
    refreshConvertListView();
  } catch {}
  try {
    (window as any).AvenorUI?.refreshEmptyState?.();
  } catch {}
}

// списки карточек
const listDownload = document.getElementById("list-download")!;
// ---- Фильтр/сортировка UI ----
const dlToolbar = document.querySelector(
  ".dl-toolbar"
) as HTMLDivElement | null;
const dlCountEl = document.getElementById("dl-count") as HTMLSpanElement | null;
const sortTrigger = document.getElementById(
  "dl-sort-trigger"
) as HTMLButtonElement | null;
const sortMenu = document.getElementById(
  "dl-sort-menu"
) as HTMLDivElement | null;

function compareCards(a: HTMLElement, b: HTMLElement): number {
  if (DL_SORT === "date") {
    const ta = Number((a as any).dataset.ts || 0);
    const tb = Number((b as any).dataset.ts || 0);
    return ta - tb;
  } else {
    const na = (a.querySelector(".title")?.textContent || "").toLowerCase();
    const nb = (b.querySelector(".title")?.textContent || "").toLowerCase();
    return na.localeCompare(nb, undefined, { numeric: true });
  }
}

function refreshDownloadListView() {
  if (!listDownload) return;

  // берём только карточки скачиваний
  const cards = Array.from(
    listDownload.querySelectorAll(".card.job-card")
  ) as HTMLElement[];

  // фильтр
  let visible = 0;
  cards.forEach((c) => {
    const type = (c as any).dataset.jobType || "download";
    if (type !== "download") {
      c.style.display = "none";
      return;
    }

    const kind = ((c as any).dataset.kind || "unknown") as
      | "video"
      | "audio"
      | "unknown";
    const show =
      DL_FILTER === "all" ||
      (DL_FILTER === "video" && kind === "video") ||
      (DL_FILTER === "audio" && kind === "audio");

    c.style.display = show ? "" : "none";
    if (show) visible++;
  });

  // сортировка DOM (сохраняем только видимые в порядке)
  const sorted = cards.slice().sort((a, b) => {
    const res = compareCards(a, b);
    return DL_DIR === "asc" ? res : -res;
  });
  // перетаскиваем по одному (дешево на наших объёмах)
  sorted.forEach((c) => listDownload.appendChild(c));

  // счётчик
  if (dlCountEl) dlCountEl.textContent = String(visible);

  // обновить пустое состояние
  try {
    (window as any).AvenorUI?.refreshEmptyState?.();
  } catch {}
}

function compareCardsCompress(a: HTMLElement, b: HTMLElement): number {
  if (CMP_SORT === "date") {
    const ta = Number((a as any).dataset.ts || 0);
    const tb = Number((b as any).dataset.ts || 0);
    return ta - tb;
  } else {
    const na = (a.querySelector(".title")?.textContent || "").toLowerCase();
    const nb = (b.querySelector(".title")?.textContent || "").toLowerCase();
    return na.localeCompare(nb, undefined, { numeric: true });
  }
}

function refreshCompressListView() {
  if (!listCompress) return;

  const cards = Array.from(
    listCompress.querySelectorAll(".card.job-card")
  ) as HTMLElement[];

  let visible = 0;
  cards.forEach((c) => {
    const kind = ((c as any).dataset.kind || "unknown") as
      | "video"
      | "audio"
      | "unknown";

    const show =
      CMP_FILTER === "all" ||
      (CMP_FILTER === "video" && kind === "video") ||
      (CMP_FILTER === "audio" && kind === "audio");

    c.style.display = show ? "" : "none";
    if (show) visible++;
  });

  const sorted = cards.slice().sort((a, b) => {
    const res = compareCardsCompress(a, b);
    return CMP_DIR === "asc" ? res : -res;
  });
  sorted.forEach((c) => listCompress.appendChild(c));

  if (cmpCountEl) cmpCountEl.textContent = String(visible);

  try {
    (window as any).AvenorUI?.refreshEmptyState?.();
  } catch {}
}

function compareCardsConvert(a: HTMLElement, b: HTMLElement): number {
  if (CNV_SORT === "date") {
    const ta = Number((a as any).dataset.ts || 0);
    const tb = Number((b as any).dataset.ts || 0);
    return ta - tb;
  } else {
    const na = (a.querySelector(".title")?.textContent || "").toLowerCase();
    const nb = (b.querySelector(".title")?.textContent || "").toLowerCase();
    return na.localeCompare(nb, undefined, { numeric: true });
  }
}

function refreshConvertListView() {
  if (!listConvert) return;

  const cards = Array.from(
    listConvert.querySelectorAll(".card.job-card")
  ) as HTMLElement[];

  let visible = 0;
  cards.forEach((c) => {
    const kind = ((c as any).dataset.kind || "unknown") as
      | "video"
      | "audio"
      | "unknown";

    const show =
      CNV_FILTER === "all" ||
      (CNV_FILTER === "video" && kind === "video") ||
      (CNV_FILTER === "audio" && kind === "audio");

    c.style.display = show ? "" : "none";
    if (show) visible++;
  });

  const sorted = cards.slice().sort((a, b) => {
    const res = compareCardsConvert(a, b);
    return CNV_DIR === "asc" ? res : -res;
  });
  sorted.forEach((c) => listConvert.appendChild(c));

  if (cnvCountEl) cnvCountEl.textContent = String(visible);

  try {
    (window as any).AvenorUI?.refreshEmptyState?.();
  } catch {}
}

function initDownloadToolbar() {
  // категории ТОЛЬКО внутри панели "Скачать"
  const cats = panelDownload
    ? panelDownload.querySelectorAll<HTMLButtonElement>(".dl-cat")
    : ([] as any as NodeListOf<HTMLButtonElement>);

  cats.forEach((btn) => {
    btn.onclick = () => {
      cats.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      DL_FILTER = (btn.dataset.cat as any) || "all";
      refreshDownloadListView();
    };
  });

  // меню сортировки
  if (sortTrigger && sortMenu) {
    const toggle = () => {
      syncSortMenu(); // ← обновляем выделение перед показом
      sortMenu.classList.toggle("open");
    };
    sortTrigger.onclick = toggle;

    document.addEventListener("click", (e) => {
      if (
        !sortMenu.contains(e.target as Node) &&
        !sortTrigger.contains(e.target as Node)
      )
        sortMenu.classList.remove("open");
    });

    sortMenu.querySelectorAll<HTMLElement>(".sort-opt").forEach((opt) => {
      opt.onclick = () => {
        if (opt.dataset.sort) {
          DL_SORT = opt.dataset.sort as any;
        }
        if (opt.dataset.dir) {
          DL_DIR = opt.dataset.dir as any;
        }
        syncSortMenu(); // ← выделяем актуальные пункты
        sortMenu.classList.remove("open");
        refreshDownloadListView();
      };
    });

    syncSortMenu(); // ← первичная подсветка
  }

  refreshDownloadListView();
}

function initCompressToolbar() {
  // категории ТОЛЬКО внутри панели "Сжать"
  const cats = panelCompress
    ? panelCompress.querySelectorAll<HTMLButtonElement>(".dl-cat")
    : ([] as any as NodeListOf<HTMLButtonElement>);

  cats.forEach((btn) => {
    btn.onclick = () => {
      cats.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      CMP_FILTER = (btn.dataset.cat as any) || "all";
      refreshCompressListView();
    };
  });

  // меню сортировки
  if (sortTriggerCompress && sortMenuCompress) {
    const toggle = () => {
      syncSortMenuCompress();
      sortMenuCompress.classList.toggle("open");
    };
    sortTriggerCompress.onclick = toggle;

    document.addEventListener("click", (e) => {
      if (
        !sortMenuCompress.contains(e.target as Node) &&
        !sortTriggerCompress.contains(e.target as Node)
      )
        sortMenuCompress.classList.remove("open");
    });

    sortMenuCompress
      .querySelectorAll<HTMLElement>(".sort-opt")
      .forEach((opt) => {
        opt.onclick = () => {
          if (opt.dataset.sort) {
            CMP_SORT = opt.dataset.sort as any;
          }
          if (opt.dataset.dir) {
            CMP_DIR = opt.dataset.dir as any;
          }
          syncSortMenuCompress();
          sortMenuCompress.classList.remove("open");
          refreshCompressListView();
        };
      });

    syncSortMenuCompress();
  }

  refreshCompressListView();
}
function initConvertToolbar() {
  const cats = panelConvert
    ? panelConvert.querySelectorAll<HTMLButtonElement>(".dl-cat")
    : ([] as any as NodeListOf<HTMLButtonElement>);

  cats.forEach((btn) => {
    btn.onclick = () => {
      cats.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      CNV_FILTER = (btn.dataset.cat as any) || "all";
      refreshConvertListView();
    };
  });

  if (sortTriggerConvert && sortMenuConvert) {
    const toggle = () => {
      syncSortMenuConvert();
      sortMenuConvert.classList.toggle("open");
    };
    sortTriggerConvert.onclick = toggle;

    document.addEventListener("click", (e) => {
      if (
        !sortMenuConvert.contains(e.target as Node) &&
        !sortTriggerConvert.contains(e.target as Node)
      ) {
        sortMenuConvert.classList.remove("open");
      }
    });

    sortMenuConvert
      .querySelectorAll<HTMLElement>(".sort-opt")
      .forEach((opt) => {
        opt.onclick = () => {
          if (opt.dataset.sort) {
            CNV_SORT = opt.dataset.sort as any;
          }
          if (opt.dataset.dir) {
            CNV_DIR = opt.dataset.dir as any;
          }
          syncSortMenuConvert();
          sortMenuConvert.classList.remove("open");
          refreshConvertListView();
        };
      });

    syncSortMenuConvert();
  }

  refreshConvertListView();
}

// инициализация после загрузки
document.addEventListener("DOMContentLoaded", async () => {
  try {
    const api: any = (window as any).Avenor;

    let profile: UserProfile | null = null;

    // 1) Пытаемся взять лицензию из main (licenseService)
    if (api?.getLicense) {
      try {
        let lic: any = await api.getLicense();
        CURRENT_LICENSE = lic;

        // если есть email — пробуем ОБНОВИТЬ статус через Supabase,
        // но не чаще, чем раз в сутки
        if (lic && lic.email && shouldRefreshLicense(lic)) {
          try {
            const backend = await fetchProfileFromBackend(lic.email);
            const nowIso = new Date().toISOString();

            if (backend && backend.isPro) {
              // есть активная PRO на бэке
              lic = {
                ...lic,
                email: backend.email,
                isPro: true,
                plan: "pro", // тип плана можешь потом детализировать
                proUntil: backend.proUntil ?? null,
                lastCheckedAt: nowIso,
              };
            } else {
              // нет активной подписки → делаем Free
              lic = {
                ...lic,
                isPro: false,
                plan: "free",
                proUntil: null,
                lastCheckedAt: nowIso,
              };
            }

            if (api.setLicense) {
              await api.setLicense(lic);
            }
          } catch (e) {
            console.warn("[profile] startup license refresh failed", e);
          }
        }

        // после возможного авто-обновления считаем, активна ли подписка
        if (lic && lic.email) {
          const active = isLicenseActive({
            isPro: lic.isPro,
            proUntil: lic.proUntil,
          });

          profile = {
            email: String(lic.email),
            plan: active ? "pro" : "free",
            isPro: active,
            proUntil: lic.proUntil ?? null,
          };

          // если в файле лицензия числится PRO, но срок уже кончился —
          // сразу сбрасываем её в Free
          if (!active && lic.isPro && api.setLicense) {
            try {
              await api.setLicense({
                ...lic,
                plan: "free",
                isPro: false,
              });
            } catch {}
          }
        }
      } catch (e) {
        console.warn("[profile] load license from main failed", e);
      }
    }

    // 2) Если профиля нет — пробуем старый localStorage как запасной вариант
    if (!profile) {
      const stored = loadProfileFromStorage();
      if (stored) profile = stored;
    }

    // 3) Применяем найденный профиль (или оставляем Free)
    if (profile) {
      proState.profile = profile;
      saveProfileLocally(profile);
    }

    applyProfileToUI();

    // 4) Инициализация UI
    initDownloadToolbar();
    initCompressToolbar();
    initConvertToolbar();
    initAccountCard();
    updateFreeUsageBar();
  } catch (e) {
    console.error("[renderer] DOMContentLoaded init error", e);
  }

  // история как и раньше
  renderHistoryOnStartup().catch(() => {});
});



const listCompress = document.getElementById("list-compress")!;
// Счётчик и сортировка для истории сжатия
const cmpCountEl = document.getElementById(
  "dl-count-compress"
) as HTMLSpanElement | null;
const sortTriggerCompress = document.getElementById(
  "dl-sort-trigger-compress"
) as HTMLButtonElement | null;
const sortMenuCompress = document.getElementById(
  "dl-sort-menu-compress"
) as HTMLDivElement | null;

// Список и тулбар для истории конвертации
const listConvert = document.getElementById(
  "list-convert"
) as HTMLElement | null;

const cnvCountEl = document.getElementById(
  "dl-count-convert"
) as HTMLSpanElement | null;
const sortTriggerConvert = document.getElementById(
  "dl-sort-trigger-convert"
) as HTMLButtonElement | null;
const sortMenuConvert = document.getElementById(
  "dl-sort-menu-convert"
) as HTMLDivElement | null;

// может и не быть — делаем опциональным
const imageSeg = document.getElementById("imageSeg") as HTMLDivElement | null;

// элементы сжатия
const dropCompress = document.querySelector(
  'label[for="fileInputCompress"]'
) as HTMLLabelElement | null;
const fileInput = document.getElementById(
  "fileInputCompress"
) as HTMLInputElement | null;

// новое поле «Размер на выходе»
const compressTargetSize = document.getElementById(
  "compressTargetSize"
) as HTMLInputElement | null;

const cmodeSize = document.getElementById("cmodeSize") as HTMLInputElement;
const cmodePercent = document.getElementById(
  "cmodePercent"
) as HTMLInputElement;
const targetMB = document.getElementById("targetMB") as HTMLInputElement;
const targetPercent = document.getElementById(
  "targetPercent"
) as HTMLInputElement;
const imageFormat = document.getElementById("imageFormat") as HTMLSelectElement;
const pickFolderCompressBtn = document.getElementById(
  "pickFolderCompress"
) as HTMLButtonElement;
const savePathCompressSpan = document.getElementById(
  "savePathCompress"
) as HTMLSpanElement;
const startCompressBtn = document.getElementById(
  "startCompress"
) as HTMLButtonElement;
const pickedFileLabel = document.getElementById(
  "pickedFileLabel"
) as HTMLSpanElement;
const pickedFileSize = document.getElementById(
  "pickedFileSize"
) as HTMLSpanElement | null;
let pickedFileSizeBytes: number | null = null;

// --- Convert tab elements ---
const tabConvert = document.getElementById(
  "tab-convert"
) as HTMLButtonElement | null;
const panelConvert = document.getElementById(
  "panel-convert"
) as HTMLDivElement | null;

// если панель конверта позже дорисовывается — подхватим и привяжем события
if (panelConvert) {
  const mo = new MutationObserver(() => ensureConvertWiring());
  mo.observe(panelConvert, { childList: true, subtree: true });
}

// --- Settings tab: используем элементы из HTML как есть ---
const tabSettings = document.getElementById(
  "tab-settings"
) as HTMLButtonElement | null;
const panelSettings = document.getElementById(
  "panel-settings"
) as HTMLDivElement | null;

function applyTabsI18n() {
  if (tabDownload) tabDownload.textContent = tr("tabs.download");
  if (tabCompress) tabCompress.textContent = tr("tabs.compress");
  if (tabConvert) tabConvert.textContent = tr("tabs.convert");
  if (tabSettings) tabSettings.textContent = tr("tabs.settings");
}

// === ПУСТОЕ СОСТОЯНИЕ: водяные знаки для списков ===
function setupEmptyState() {
  type Pair = { list: HTMLElement; empty: HTMLElement };

  const pairs: Pair[] = [];

  const addPair = (listId: string, emptyId: string) => {
    const list = document.getElementById(listId) as HTMLElement | null;
    const empty = document.getElementById(emptyId) as HTMLElement | null;
    if (list && empty) {
      pairs.push({ list, empty });
    }
  };

  // Скачать
  addPair("list-download", "download-empty");
  // Сжать
  addPair("list-compress", "compress-empty");
  // Конвертировать
  addPair("list-convert", "convert-empty");

  if (!pairs.length) return;

  const refreshOne = (p: Pair) => {
    const hasCards = !!p.list.querySelector(".job-card");
    p.empty.classList.toggle("hidden", hasCards);
    p.empty.setAttribute("aria-hidden", String(hasCards));
  };

  const refreshAll = () => {
    pairs.forEach(refreshOne);
  };

  // Следим за изменениями в каждом списке
  pairs.forEach(({ list }) => {
    const mo = new MutationObserver(refreshAll);
    mo.observe(list, { childList: true });
  });

  // Первичный вызов
  refreshAll();

  // Делаем ручной рефреш доступным из других мест
  (window as any).AvenorUI = {
    ...(window as any).AvenorUI,
    refreshEmptyState: refreshAll,
  };
}

document.addEventListener("DOMContentLoaded", () => {
  try {
    setupEmptyState();
  } catch {}
});

// === МЯГКИЕ ЧАСТИЦЫ НА ФОНЕ (звёздная пыль) ===
function initParticles() {
  const prefersReduced = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)"
  )?.matches;
  if (prefersReduced) return;

  // берём/создаём канвас на всём окне
  let el = document.getElementById("bg-particles");
  if (!el) {
    el = document.createElement("canvas");
    el.id = "bg-particles";
    el.className = "bg-particles";
    document.body.prepend(el);
  }
  if (!(el instanceof HTMLCanvasElement)) return;
  const canvas: HTMLCanvasElement = el;

  // --- контекст рисования ---
  let ctx!: CanvasRenderingContext2D;
  const _ctx = canvas.getContext("2d", { alpha: true });
  if (!_ctx) return;
  ctx = _ctx;

  let dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  // Параметры — можно подстроить
  const PARTICLE_COUNT = Math.round(
    (window.innerWidth * window.innerHeight) / 18000
  ); // ~60–120 на FHD
  const SPEED_MIN = 0.04; // px/frame
  const SPEED_MAX = 0.22;
  const SIZE_MIN = 0.6; // px
  const SIZE_MAX = 1.8;

  // Цвета под твою тему (фиолет/индиго/голубой, полупрозрачные)
  const COLORS = [
    "rgba(180, 150, 255, 0.85)",
    "rgba(140, 190, 255, 0.75)",
    "rgba(255, 160, 220, 0.70)",
    "rgba(140, 160, 255, 0.80)",
  ];

  type P = {
    x: number;
    y: number;
    vx: number;
    vy: number;
    r: number;
    c: string;
    tw: number;
  }; // tw — «качание» траектории
  let W = 0,
    H = 0;
  let particles: P[] = [];
  let raf = 0;

  function resize() {
    dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    // 👉 полноэкранные размеры
    W = window.innerWidth;
    H = window.innerHeight;

    // синхронизируем CSS-размер (для корректного clientWidth/Height)
    canvas.style.width = "100vw";
    canvas.style.height = "100vh";

    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function rnd(a: number, b: number) {
    return a + Math.random() * (b - a);
  }

  function spawnParticle(): P {
    const angle = Math.random() * Math.PI * 2;
    const speed = rnd(SPEED_MIN, SPEED_MAX);
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed * 0.6, // чуть медленнее по Y — «парение»
      r: rnd(SIZE_MIN, SIZE_MAX),
      c: COLORS[(Math.random() * COLORS.length) | 0],
      tw: rnd(0.002, 0.006), // частота «покачивания»
    };
  }

  function resetParticles() {
    particles = Array.from({ length: PARTICLE_COUNT }, spawnParticle);
  }

  function step(t: number) {
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter"; // мягкое свечение при наложении

    for (let p of particles) {
      // лёгкая синусоида для «невесомости»
      const sway = Math.sin(t * p.tw) * 0.25;
      p.x += p.vx + sway;
      p.y += p.vy;

      // выход за край → перенос на противоположную сторону (бесшовность)
      if (p.x < -8) p.x = W + 8;
      else if (p.x > W + 8) p.x = -8;
      if (p.y < -8) p.y = H + 8;
      else if (p.y > H + 8) p.y = -8;

      // рисуем маленький «светлячок»
      const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 3);
      grd.addColorStop(0, p.c);
      grd.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    raf = requestAnimationFrame(step);
  }

  function onVisibility(v: boolean) {
    if (!v) {
      cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    if (!raf) raf = requestAnimationFrame(step);
  }

  // init
  resize();
  resetParticles();
  onVisibility(!document.hidden);

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () =>
    onVisibility(!document.hidden)
  );
}

// Запуск после загрузки DOM
document.addEventListener("DOMContentLoaded", () => {
  try {
    initParticles();
  } catch (e) {
    /* тихо игнорим, если что-то не так */
  }
});

const dropConvert = document.getElementById(
  "dropConvert"
) as HTMLLabelElement | null;
const fileInputConvert = document.getElementById(
  "fileInputConvert"
) as HTMLInputElement | null;

const targetFormat = document.getElementById(
  "targetFormat"
) as HTMLSelectElement | null;
const pickFolderConvertBtn = document.getElementById(
  "pickFolderConvert"
) as HTMLButtonElement | null;
const savePathConvertSpan = document.getElementById(
  "savePathConvert"
) as HTMLSpanElement | null;
const startConvertBtn = document.getElementById(
  "startConvert"
) as HTMLButtonElement | null;
const pickedFileLabelConvert = document.getElementById(
  "pickedFileLabelConvert"
) as HTMLSpanElement | null;

const convertVideoOpts = document.getElementById(
  "convertVideoOpts"
) as HTMLDivElement | null;
const convertImageOpts = document.getElementById(
  "convertImageOpts"
) as HTMLDivElement | null;
const convertTypeSel = document.getElementById(
  "convertType"
) as HTMLSelectElement | null;

let pickedConvertPath: string | null = null;
let outDirConvert: string | undefined;
let pickedConvertSizeBytes: number | null = null;

let outDirCompress: string | undefined;
let pickedFilePath: string | null = null;

let outDir: string | undefined;

const extOf = (p: string | null) =>
  p ? (p.split(".").pop() || "").toLowerCase() : "";
const isImageExt = (e: string) =>
  [
    "jpg",
    "jpeg",
    "png",
    "bmp",
    "tif",
    "tiff",
    "gif",
    "webp",
    "heic",
    "heif",
  ].includes(e);
const isAudioExt = (e: string) =>
  ["mp3", "wav", "aac", "m4a", "flac", "ogg", "opus"].includes(e);

function kindOf(p: string | null): "image" | "audio" | "video" | "unknown" {
  const e = extOf(p);
  if (!e) return "unknown";
  if (isImageExt(e)) return "image";
  if (isAudioExt(e)) return "audio";
  return "video";
}

let convertWired = false;
function ensureConvertWiring() {
  const drop = document.getElementById(
    "dropConvert"
  ) as HTMLLabelElement | null;
  const fin = document.getElementById(
    "fileInputConvert"
  ) as HTMLInputElement | null;
  const pickedLbl = document.getElementById(
    "pickedFileLabelConvert"
  ) as HTMLSpanElement | null;

  if (!drop || !fin) {
    // панель ещё не смонтирована — подождём
    return;
  }
  if (convertWired) return;
  convertWired = true;

  // 1) label уже связан через for="fileInputConvert" — этого достаточно
  try {
    drop.setAttribute("for", "fileInputConvert");
  } catch {}
  (drop as any).style.cursor = "pointer";
  (drop as any).tabIndex = 0;

  // 2) клавиатура — Enter/Space вручную триггерят input
  drop.onkeydown = (e: any) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      try {
        fin.click();
      } catch {}
    }
  };

  // 3) изменение файла
  fin.onchange = () => {
    const f = fin.files && fin.files[0];
    pickedConvertPath = safePath(f);
    pickedConvertSizeBytes = f ? f.size : null;
    if (pickedLbl) {
      pickedLbl.textContent = pickedConvertPath
        ? fileBase(pickedConvertPath)!
        : tr("convert.dropHere");
    }
    updateConvertUI();
  };

  // 4) drag&drop поверх зоны
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.style.opacity = "0.9";
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.style.opacity = "1";
    })
  );
  drop.addEventListener("drop", (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer?.files?.[0];
    pickedConvertPath = safePath(f);
    pickedConvertSizeBytes = f ? f.size : null;

    if (pickedLbl) {
      pickedLbl.textContent = pickedConvertPath
        ? fileBase(pickedConvertPath)!
        : tr("convert.dropHere");
    }
    updateConvertUI();
  });

  // console.debug("[convert] wired");
}

// Глобально запретим браузеру перехватывать дроп на окно
window.addEventListener("dragover", (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest?.("#dropConvert")) return;
  e.preventDefault();
});
window.addEventListener("drop", (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest?.("#dropConvert")) return;
  e.preventDefault();
});

tabConvert?.addEventListener("click", () => {
  setTab("convert");
  ensureConvertWiring();
  updateConvertUI();
});

// Язык фиксируем на русском, без чтения/смены через настройки
document.addEventListener("DOMContentLoaded", async () => {
  ensureConvertWiring();
  updateConvertUI();

  CURRENT_LANG = "ru";

  applyTabsI18n();
  applyGlobalI18n();
  enhanceQualitySelect(true);
  updateConvertUI();
});

document
  .getElementById("btn-min")
  ?.addEventListener("click", () => window.AvenorWindow?.minimize());
document
  .getElementById("btn-max")
  ?.addEventListener("click", () => window.AvenorWindow?.toggleMaximize());
document
  .getElementById("btn-close")
  ?.addEventListener("click", () => window.AvenorWindow?.close());

// обновлять подсказку для max/restore
window.AvenorWindow?.onState?.((s: { isMaximized: boolean }) => {
  const btn = document.getElementById("btn-max") as HTMLButtonElement | null;
  if (btn) btn.title = s.isMaximized ? "Восстановить" : "Развернуть";
});

updateConvertUI();

function fillTargetFormatsByType() {
  if (!targetFormat) return;
  const lang = CURRENT_LANG;
  const opt = (v: string, l: string) => `<option value="${v}">${l}</option>`;
  const type = (convertTypeSel?.value || "video").toLowerCase();

  if (type === "image") {
    const L = (LANG[lang] || LANG.en).convert.formatsImage;
    targetFormat.innerHTML =
      opt("jpg", L.jpg) +
      opt("png", L.png) +
      opt("webp", L.webp) +
      opt("tiff", L.tiff) +
      opt("gif", L.gif);
    if (convertVideoOpts) convertVideoOpts.style.display = "";
    if (convertImageOpts) convertImageOpts.style.display = "";
  } else if (type === "audio") {
    const L = (LANG[lang] || LANG.en).convert.formatsAudio;
    targetFormat.innerHTML =
      opt("mp3", L.mp3) +
      opt("aac", L.aac) +
      opt("m4a", L.m4a) +
      opt("wav", L.wav) +
      opt("flac", L.flac) +
      opt("ogg", L.ogg) +
      opt("opus", L.opus);
    if (convertVideoOpts) convertVideoOpts.style.display = "";
    if (convertImageOpts) convertImageOpts.style.display = "none";
  } else {
    const L = (LANG[lang] || LANG.en).convert.formatsVideo;
    targetFormat.innerHTML =
      opt("mp4", L.mp4) +
      opt("mkv", L.mkv) +
      opt("mov", L.mov) +
      opt("webm", L.webm);
    if (convertVideoOpts) convertVideoOpts.style.display = "";
    if (convertImageOpts) convertImageOpts.style.display = "none";
  }
}

function updateConvertUI() {
  fillTargetFormatsByType();
}
convertTypeSel?.addEventListener("change", updateConvertUI);

console.log("[renderer] ready, Avenor=", typeof (window as any).Avenor);

// --- helpers для заголовка + дефолтная иконка сжатия ---
function fileBase(fp?: string) {
  if (!fp) return undefined;
  const m = fp.replace(/\\/g, "/").match(/([^/]+)$/);
  return m?.[1];
}
function formatBytesToSizeStr(bytes?: number | null): string {
  if (!bytes || !isFinite(bytes)) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return gb.toFixed(2) + " ГБ";
  }
  return mb.toFixed(1) + " МБ";
}

function applyTitle(titleEl: HTMLDivElement, title?: string, fp?: string) {
  const t = title || fileBase(fp);
  if (!t) return;
  titleEl.textContent = t;
  titleEl.setAttribute("title", t);
  // снимаем возможные блокировки «обновлять только один раз»
  delete (titleEl as any).dataset.titledone;
  delete (titleEl as any).dataset.placeholder;
}

const DEFAULT_COMPRESS_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6aa0ff"/>
      <stop offset="1" stop-color="#3b82f6"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="48" height="48" rx="10" fill="url(#g)"/>
  <path d="M26 18h12v6H26zm0 10h12v6H26zm0 10h12v6H26z" fill="#ffffff" opacity="0.9"/>
  <path d="M20 22h4v4h-4zm0 10h4v4h-4zm0 10h4v4h-4z" fill="#dbeafe"/>
</svg>`);

function isImagePath(p: string | null): boolean {
  if (!p) return false;
  const ext = p.split(".").pop()?.toLowerCase();
  return (
    !!ext &&
    [
      "jpg",
      "jpeg",
      "png",
      "bmp",
      "tif",
      "tiff",
      "gif",
      "webp",
      "heic",
      "heif",
    ].includes(ext)
  );
}

function updateUiForPickedFile() {
  const isImg = isImagePath(pickedFilePath);
  if (imageSeg) {
    imageSeg.style.display = isImg ? "" : "none";
  }
}

function setTab(tab: "download" | "compress" | "convert" | "settings") {
  const set = (
    btn: HTMLElement | null,
    panel: HTMLElement | null,
    on: boolean
  ) => {
    if (!btn || !panel) return;
    btn.classList.toggle("active", on);
    panel.classList.toggle("active", on);
  };

  set(tabDownload, panelDownload, tab === "download");
  set(tabCompress, panelCompress, tab === "compress");
  set(tabConvert, panelConvert, tab === "convert");
  set(tabSettings, panelSettings, tab === "settings");

  const quickBar = document.querySelector(
    "#panel-download .bar"
  ) as HTMLElement | null;

  if (quickBar) quickBar.style.display = tab === "download" ? "" : "none";
}

cmodeSize?.addEventListener("change", () => {
  targetMB.disabled = !cmodeSize.checked;
  targetPercent.disabled = cmodeSize.checked;
});
cmodePercent?.addEventListener("change", () => {
  targetPercent.disabled = !cmodePercent.checked;
  targetMB.disabled = cmodePercent.checked;
});

pickFolderCompressBtn?.addEventListener("click", async () => {
  const p = await AvenorAPI.pickFolder();
  if (p) {
    outDirCompress = p;
    savePathCompressSpan.textContent = p;
  }
});

fileInput?.addEventListener("change", () => {
  const f = fileInput.files?.[0] || null;
  pickedFilePath = safePath(f);
  pickedFileSizeBytes = f ? f.size : null;

  // имя файла — только базовое, без полного пути
  pickedFileLabel.textContent = pickedFilePath
    ? fileBase(pickedFilePath)!
    : "Файл не выбран";

  // исходный размер справа
  if (pickedFileSize) {
    pickedFileSize.textContent = f ? formatBytesToSizeStr(f.size) : "";
  }

  updateUiForPickedFile();
});

// drag&drop (если хочешь поддерживать)
["dragenter", "dragover"].forEach((ev) =>
  dropCompress?.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropCompress.style.opacity = "0.9";
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropCompress?.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropCompress.style.opacity = "1";
  })
);
dropCompress?.addEventListener("drop", (e: any) => {
  const f = e.dataTransfer?.files?.[0] || null;
  pickedFilePath = safePath(f);
  pickedFileSizeBytes = f ? f.size : null;

  pickedFileLabel.textContent = pickedFilePath
    ? fileBase(pickedFilePath)!
    : "Файл не выбран";

  if (pickedFileSize) {
    pickedFileSize.textContent = f ? formatBytesToSizeStr(f.size) : "";
  }

  updateUiForPickedFile();
});

if (dropCompress && fileInput) {
  // ОСТАВЛЯЕМ атрибут for="fileInputCompress" — пусть браузер сам открывает диалог
  dropCompress.style.cursor = "pointer";
  (dropCompress as any).tabIndex = 0;

  // Для клавиатуры — вручную вызываем клик по input
  dropCompress.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
}

startCompressBtn?.addEventListener("click", async () => {
  if (!pickedFilePath) {
    alert("Выберите файл для сжатия");
    return;
  }

  const targetMbVal = Number(compressTargetSize?.value || 0);
  if (!targetMbVal || targetMbVal <= 0) {
    alert("Укажите целевой размер в МБ");
    return;
  }

  if (targetMbVal < 5) {
    const ok = confirm(
      "Вы выбрали очень маленький размер. Качество может сильно пострадать. Продолжить?"
    );
    if (!ok) return;
  }

  // --- PRO: проверяем лимит по размеру и количеству сжатий ---
  if (
    !ensureFreeLimit({
      kind: "compress",
      fileBytes: pickedFileSizeBytes,
    })
  ) {
    return; // показываем paywall, задачу не добавляем
  }

  const isImg = isImagePath(pickedFilePath);

  const payload = {
    inputPath: pickedFilePath,
    outDir: outDirCompress,
    mode: "size",
    targetMB: targetMbVal,
    targetPercent: undefined,
    imageFormat: isImg && imageFormat ? imageFormat.value : undefined,
    audioBitrateK: 160,
  };

  try {
    // просто отправляем задачу в очередь
    await AvenorAPI.addCompressJob(payload);
    // учёт лимита теперь делаем в onProgress, когда задача реально завершится
    // noteProUsage("compress");
  } catch (e) {
    console.error("[renderer] addCompressJob failed", e);
    alert("Не удалось добавить задачу на сжатие");
  }
});

tabDownload?.addEventListener("click", () => setTab("download"));
tabCompress?.addEventListener("click", () => setTab("compress"));

function createPendingCard(titleText: string, container: HTMLElement) {
  const tempId = `temp-${Date.now()}`;
  const card = document.createElement("div");
  card.className = "card pending adding job-card"; // ← добавили класс adding
  card.id = `job-${tempId}`;
  // метки для фильтра/сортировки
  (card as any).dataset.ts = String(Date.now()); // время создания

  // тип/источник для фильтрации
  if (container === listDownload) {
    (card as any).dataset.jobType = "download";
  } else if (container === listCompress) {
    (card as any).dataset.jobType = "compress";
  } else if (container === listConvert) {
    (card as any).dataset.jobType = "convert";
  }

  (card as any).dataset.kind = "unknown";

  // разметка
  card.innerHTML = `
    <div class="dl-grid">
      <div class="thumb-wrap">
        <img class="thumb thumb--ph" alt="">
      </div>
      <div class="content">
        <div class="title" title=""></div>
        <div class="progress indeterminate"><div></div></div>
        <div class="meta"></div>
      </div>
      <div class="actions">
        <button class="icon-btn" data-cancel title="Отменить" aria-label="Отменить">
          <svg viewBox="0 0 24 24" class="icon"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
        </button>
        <button class="icon-btn" data-delete title="Удалить" aria-label="Удалить">
          <svg viewBox="0 0 24 24" class="icon"><path d="M9 3h6m-8 4h10m-1 0l-1 13H9L8 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="action" data-open>Открыть в папке</div>
      </div>
    </div>
  `;

  // стартовое состояние кнопок для pending: отмена видна, удалить скрыта
  {
    const actions = card.querySelector(".actions")!;
    (actions.querySelector("[data-delete]") as HTMLElement).style.display =
      "none";
    (actions.querySelector("[data-cancel]") as HTMLElement).style.display = "";
  }

  const titleEl = card.querySelector(".title") as HTMLDivElement;
  const thumb = card.querySelector(".thumb") as HTMLImageElement | null;

  const thumbWrap = card.querySelector(".thumb-wrap") as HTMLDivElement | null;

  if (thumb && thumbWrap) {
    // Для pending-карточки ничего не грузим, показываем спиннер
    thumb.removeAttribute("src");
    thumb.classList.add("thumb--loading");
    thumbWrap.classList.add("thumb-wrap--loading");
  }

  titleEl.textContent = titleText || "Добавляем задачу…";
  titleEl.setAttribute("title", titleEl.textContent || "");
  (titleEl as any).dataset.placeholder = "1";

  // пока путь неизвестен — «Открыть в папке» выключена
  const openBtn = card.querySelector("[data-open]") as HTMLElement;
  openBtn.setAttribute("aria-disabled", "true");
  openBtn.style.pointerEvents = "none";
  openBtn.style.opacity = "0.6";
  openBtn.onclick = () => {
    const fp = (card as any).dataset.filepath;
    if (fp) AvenorAPI.revealInFolder(fp);
  };

  const meta = card.querySelector(".meta") as HTMLDivElement;
  meta.textContent = "Статус: Подготовка";

  container.prepend(card);
  try {
    (window as any).AvenorUI?.refreshEmptyState?.();
  } catch {}

  return { card, tempId };
}

// Кнопка «Вставить ссылку» — берём из буфера и стартуем без промпта
pasteBtn?.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    console.log("[renderer] pasteBtn clipboard=", text);
    if (!text) {
      alert("В буфере нет ссылки");
      return;
    }
    addUrl(text.trim());
  } catch (e) {
    console.warn("[renderer] clipboard read failed", e);
    alert("Не удалось прочитать буфер обмена");
  }
});

// Кнопка «Сохранить в…»
pickFolderBtn?.addEventListener("click", async () => {
  const api = AvenorAPI;
  if (!api) return;
  const p = await api.pickFolder();
  if (p) {
    outDir = p;
    savePathSpan.textContent = p;
  }
});

async function addUrl(url: string) {
  // сначала определяем выбранное качество и тип (аудио/видео)
  const selected = qualitySel.value as QualityKey;
  const asAudio = selected === "audio";
  // --- PRO: проверяем лимиты для вкладки "Скачать" ---
  const qualityForCheck = asAudio ? null : selected;
  if (
    !ensureFreeLimit({
      kind: "download",
      quality: qualityForCheck,
    })
  ) {
    return; // показываем paywall и не создаём задачу
  }

  // создаём pending-карточку и сразу помечаем тип для фильтра
  const { card } = createPendingCard("Добавляем задачу…", listDownload);
  (card as any).dataset.kind = asAudio ? "audio" : "video";
  (card as any).dataset.jobType = "download";

  const s = SETTINGS_STATE || (await (window as any).Avenor.getSettings());

  const payload: AddJobPayload = {
    url,
    type: asAudio ? "audio" : "video",
    quality: asAudio ? "best" : selected, // для аудио качество не важно
    outDir: outDir || s.downloadDir,
  };

  AvenorAPI.addJob(payload)
    .then((id: string) => {
      // переименовываем временную карточку под реальный id
      card.id = `job-${id}`;
      (card as any).dataset.jobId = id;
      card.classList.remove("pending");
      refreshDownloadListView();

      // запоминаем, с каким качеством и типом запускали эту задачу
      JOB_QUALITY.set(id, selected);
      JOB_KIND.set(id, asAudio ? "audio" : "video");
      // ВАЖНО: здесь больше НЕ вызываем noteProUsage("download");
      // будем считать загрузку только при успешном завершении (stage=done)
    })

    .catch((e: any) => {
      console.error("[renderer] addJob failed", e);
      const meta = card.querySelector(".meta") as HTMLDivElement;
      meta.textContent = "Статус: Ошибка запуска";
      refreshDownloadListView();
    });
}

// Хелпер: достать высоту (p) из строки разрешения вида "1920x1080" или "1080p"
function parseHeightFromRes(res?: string): number | undefined {
  if (!res) return;
  if (/^\d+x\d+$/i.test(res)) {
    return parseInt(res.split("x")[1], 10);
  }
  if (/^\d+p$/i.test(res)) {
    return parseInt(res, 10);
  }
  return undefined;
}

// Подписка на прогресс из main
AvenorAPI.onProgress((p: JobProgress) => {
  const id = `job-${p.id}`;

  // берём source, а если его нет — пробуем meta.jobType
  const jt = (p as any).source || (p as any).meta?.jobType;
  const targetListRaw =
    jt === "compress"
      ? listCompress
      : jt === "convert"
      ? listConvert
      : listDownload;

  const targetList = (targetListRaw ?? listDownload)!;

  let card = document.getElementById(id) as HTMLDivElement | null;

  // звук при переходе в done / error
  let prev = "";
  if (card && (card as any).dataset) {
    prev = (card as any).dataset.stagePrev || "";
  }

  // --- PRO-логика: блокируем BEST, если видео >1080p и юзер не PRO ---
  if (
    !IS_PRO && // только для FREE
    (p as any).source === "download" && // только вкладка "Скачать"
    p.stage === "preparing" && // на этапе подготовки, когда уже есть meta
    p.meta?.resolution
  ) {
    const requested = JOB_QUALITY.get(p.id);
    const kind = JOB_KIND.get(p.id) || "video";
    const h = parseHeightFromRes(p.meta.resolution);

    // если человек выбрал BEST для видео, а реальное видео выше 1080p
    if (requested === "best" && kind === "video" && h && h > 1080) {
      // отменяем задачу в очереди
      AvenorAPI.cancelJob?.(p.id).catch(() => {});

      // показываем paywall
      showProPaywall(
        "Режим «Лучшее» для видео выше 1080p доступен только в Avenor PRO.\n" +
          "Выберите конкретное качество (1080p и ниже) или оформите PRO."
      );

      return; // дальше не обновляем карточку
    }
  }

  (async () => {
    try {
      const s = SETTINGS_STATE || await(window as any).Avenor.getSettings();

      // пробуем прочитать актуальное состояние чекбоксов в UI
      const soundDoneCb = document.getElementById(
        "settings-sound-done"
      ) as HTMLInputElement | null;
      const soundErrorCb = document.getElementById(
        "settings-sound-error"
      ) as HTMLInputElement | null;

      const doneEnabled =
        soundDoneCb != null ? soundDoneCb.checked : !!s.soundDoneEnabled;

      const errorEnabled =
        soundErrorCb != null ? soundErrorCb.checked : !!s.soundErrorEnabled;

      if (p.stage === "done" && prev !== "done" && doneEnabled && SFX.done) {
        new Audio(SFX.done).play().catch(() => {});
      }

      if (
        p.stage === "error" &&
        prev !== "error" &&
        errorEnabled &&
        SFX.error
      ) {
        new Audio(SFX.error).play().catch(() => {});
      }
      // считаем загрузку в лимиты FREE только при успешном завершении
      // считаем операции в лимиты FREE только при успешном завершении
      if (p.stage === "done" && prev !== "done") {
        const src = (p as any).source;
        if (src === "download") noteProUsage("download");
        else if (src === "compress") noteProUsage("compress");
        else if (src === "convert") noteProUsage("convert");
      }
    } catch {}
  })();

  // если карточки ещё нет — создаём в нужном списке
  if (!card) {
    card = document.createElement("div");
    card.className = "card job-card";
    card.id = id;
    card.innerHTML = `
      <div class="dl-grid">
        <div class="thumb-wrap">
          <img class="thumb thumb--ph" alt="">
        </div>
        <div class="content">
          <div class="title" title=""></div>
          <div class="progress"><div></div></div>
          <div class="meta"></div>
        </div>
        <div class="actions">
          <button class="icon-btn" data-cancel title="Отменить" aria-label="Отменить">
            <svg viewBox="0 0 24 24" class="icon"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
          </button>
          <button class="icon-btn" data-delete title="Удалить" aria-label="Удалить">
            <svg viewBox="0 0 24 24" class="icon"><path d="M9 3h6m-8 4h10m-1 0l-1 13H9L8 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="action" data-open>Открыть в папке</div>
        </div>
      </div>
    `;

    (card as any).dataset.jobType = jt || "download";
    const hasVideo = !!p.meta?.vcodec || !!p.meta?.resolution;
    (card as any).dataset.kind = hasVideo ? "video" : "audio";

    targetList.prepend(card);

    try {
      refreshDownloadListView();
      refreshCompressListView();
      refreshConvertListView();
    } catch {}

    const openBtn0 = card.querySelector("[data-open]") as HTMLElement;
    openBtn0.setAttribute("aria-disabled", "true");
    openBtn0.style.pointerEvents = "none";
    openBtn0.style.opacity = "0.6";
  }

  // ---- дальше карточка гарантированно есть ----
  const cardEl = card!;

  (cardEl as any).dataset.jobId = p.id;
  (cardEl as any).dataset.ts ??= String(Date.now());
  cardEl.classList.remove("pending", "adding"); // ← убираем pending при первом прогрессе

  const thumbEl = cardEl.querySelector(".thumb") as HTMLImageElement | null;
  const titleEl = cardEl.querySelector(".title") as HTMLDivElement;
  const metaEl = cardEl.querySelector(".meta") as HTMLDivElement;
  const openBtn = cardEl.querySelector("[data-open]") as HTMLElement;
  const progressWrap = cardEl.querySelector(".progress") as HTMLDivElement;
  const bar = cardEl.querySelector(".progress > div") as HTMLDivElement;
  const cancelBtn = cardEl.querySelector("[data-cancel]") as HTMLButtonElement;
  const deleteBtn = cardEl.querySelector("[data-delete]") as HTMLButtonElement;

  // кнопки
  cancelBtn.onclick = () => {
    AvenorAPI.cancelJob?.(p.id).catch(() => {});
  };
  deleteBtn.onclick = () => {
    if (AvenorAPI.removeJob) {
      AvenorAPI.removeJob(p.id).finally(() => cardEl.remove());
    } else {
      cardEl.remove();
      try {
        (window as any).AvenorUI?.refreshEmptyState?.();
      } catch {}
    }
  };

  const isActive = !["done", "error", "canceled"].includes(p.stage);
  cancelBtn.style.display = isActive ? "" : "none";
  deleteBtn.style.display = isActive ? "none" : "";

  cardEl.classList.toggle("done", p.stage === "done");
  cardEl.classList.toggle("error", p.stage === "error");

  // превью
  if (p.meta?.thumbnail && thumbEl) {
    const tryList = buildThumbFallbacks(p.meta.thumbnail);
    let i = 0;
    const tryNext = () => {
      if (i >= tryList.length) return;
      thumbEl.src = tryList[i++];
    };
    thumbEl.onerror = tryNext;
    tryNext();

    const wrap = thumbEl.closest(".thumb-wrap") as HTMLElement | null;
    wrap?.classList.remove("thumb-wrap--loading");
    thumbEl.classList.remove("thumb--loading");
    thumbEl.classList.remove("thumb--ph");
  } else if (thumbEl) {
    const kind =
      (cardEl as any).dataset.kind ||
      (p as any).kind ||
      (p.meta?.vcodec || p.meta?.resolution ? "video" : "audio");

    const isAudio =
      kind === "audio" ||
      isAudioExtName(p.meta?.ext) ||
      (!!p.meta?.acodec && !p.meta?.vcodec);

    if (isAudio) {
      thumbEl.removeAttribute("src");
      thumbEl.classList.add("thumb--audio");
      const wrap = thumbEl.closest(".thumb-wrap") as HTMLElement | null;
      wrap?.classList.remove("thumb-wrap--loading");
      thumbEl.classList.remove("thumb--loading");
      thumbEl.classList.remove("thumb--ph");
    }
  }

  // заголовок
  if (p.meta?.title) {
    applyTitle(titleEl, p.meta.title, p.filepath);
  }

  // прогресс: для done насильно ставим 100% и убираем indeterminate
  bar.style.transition = "width 0.25s linear";

  if (p.stage === "done") {
    progressWrap.classList.remove("indeterminate");
    bar.style.width = "100%";
  } else if (p.percent != null) {
    // есть конкретный процент
    progressWrap.classList.remove("indeterminate");
    const clamped = Math.max(0, Math.min(100, p.percent));
    bar.style.width = `${clamped}%`;
  } else if (p.stage === "error" || p.stage === "canceled") {
    // ошибка или отмена без процента — прекращаем анимацию
    progressWrap.classList.remove("indeterminate");
    // если ширина ещё не задана — зафиксируем на 0%
    if (!bar.style.width) {
      bar.style.width = "0%";
    }
  }

  // статусная строка
  const parts: string[] = [];

  const formatSizeMB = (mb?: number) =>
    !mb || !isFinite(mb)
      ? undefined
      : mb >= 1024
      ? `${(mb / 1024).toFixed(2)} GB`
      : `${mb.toFixed(1)} MB`;

  const formatDuration = (sec?: number) => {
    if (!sec || !isFinite(sec)) return undefined;
    const s = String(Math.floor(sec % 60)).padStart(2, "0");
    const m = String(Math.floor((sec / 60) % 60)).padStart(2, "0");
    const h = Math.floor(sec / 3600);
    return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
  };

  const resLabel = (res?: string) => {
    if (!res) return undefined;
    let h: number | undefined;
    if (/^\d+x\d+$/i.test(res)) h = parseInt(res.split("x")[1], 10);
    else if (/^\d+p$/i.test(res)) h = parseInt(res, 10);
    if (!h) return;
    if (h >= 4320) return "8K";
    if (h >= 2160) return "4K";
    if (h >= 1440) return "2K";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    if (h >= 360) return "360p";
    return `${h}p`;
  };

  if (p.stage === "preparing") {
    metaEl.textContent = "Статус: Подготовка";
  } else if (p.stage === "done") {
    if (p.meta?.title || (p as any).meta?.outName) {
      const t = p.meta?.title ?? (p as any).meta?.outName;
      titleEl.textContent = t!;
      titleEl.setAttribute("title", t!);
      (titleEl as any).dataset.titledone = "1";
    }
    const r = resLabel(p.meta?.resolution);
    if (r) parts.push(r);
    if (p.meta?.fps) parts.push(`${p.meta.fps} FPS`);
    const dur = formatDuration(p.meta?.durationSec);
    if (dur) parts.push(dur);
    const sizeStr = formatSizeMB(p.meta?.sizeMB);
    if (sizeStr) parts.push(sizeStr);
    if (p.meta?.ext) parts.push(p.meta.ext.toUpperCase());
    parts.unshift("Готово");
    metaEl.textContent = parts.join(" • ");
  } else if (p.stage === "canceled") {
    metaEl.textContent = "Отменено";
    cancelBtn.style.display = "none";
    deleteBtn.style.display = "";
  } else {
    applyTitle(titleEl, p.meta?.title, p.filepath);
    parts.push(`Статус: ${mapStage(p.stage, jt)}`);
    if (p.totalMB) parts.push(`Размер: ${p.totalMB.toFixed(1)} MB`);
    if (p.downloadedMB) parts.push(`Скачано: ${p.downloadedMB.toFixed(1)} MB`);
    if (p.speed) parts.push(`Скорость: ${p.speed}`);
    if (p.eta) parts.push(`ETA: ${p.eta}`);
    if (p.message && p.stage === "error") parts.push(`Ошибка: ${p.message}`);
    metaEl.textContent = parts.join(" • ");
  }

  if (p.filepath) {
    (cardEl as any).dataset.filepath = p.filepath;
    openBtn.onclick = () => {
      AvenorAPI.revealInFolder(p.filepath!).catch(() => {});
    };
    openBtn.removeAttribute("aria-disabled");
    openBtn.style.pointerEvents = "auto";
    openBtn.style.opacity = "";
  }

  (cardEl as any).dataset.stagePrev = p.stage || "";
});

function mapStage(s: any, jobType?: "download" | "compress" | "convert") {
  switch (s) {
    case "preparing":
    case "probe":
      return "Подготовка";

    case "pass1":
      return jobType === "convert" ? "Конвертация (1/2)" : "Проход 1/2";

    case "pass2":
      return jobType === "convert" ? "Конвертация (2/2)" : "Проход 2/2";

    case "encoding":
      return jobType === "convert" ? "Конвертация" : "Кодирование";

    case "compressing":
      return jobType === "convert" ? "Конвертация" : "Сжатие";

    case "downloading":
      return "Загрузка";

    case "merging":
      return jobType === "convert" ? "Финализация" : "Слияние";

    case "post":
      return jobType === "convert" ? "Пост-обработка" : "Пост-обработка";

    case "done":
      return "Готово";

    case "error":
      return "Ошибка";

    case "canceled":
      return "Отменено";

    default:
      return jobType === "convert" ? "Конвертация…" : "В работе";
  }
}

// выбор папки
pickFolderConvertBtn?.addEventListener("click", async () => {
  const p = await AvenorAPI.pickFolder();
  if (p) {
    outDirConvert = p;
    if (savePathConvertSpan) savePathConvertSpan.textContent = p;
  }
});

// старт конвертации
startConvertBtn?.addEventListener("click", async () => {
  if (!pickedConvertPath) {
    alert("Выберите файл для конвертации");
    return;
  }

  // --- PRO: проверяем лимит по размеру и количеству конвертаций ---
  if (
    !ensureFreeLimit({
      kind: "convert",
      fileBytes: pickedConvertSizeBytes,
    })
  ) {
    return;
  }

  const typeSel = (convertTypeSel?.value || "video").toLowerCase();
  const payload: any = {
    inputPath: pickedConvertPath,
    outDir: outDirConvert,
    targetExt:
      targetFormat?.value ||
      (typeSel === "audio" ? "mp3" : typeSel === "image" ? "jpg" : "mp4"),
  };

  try {
    // просто добавляем задачу в очередь,
    // карточку создаст onProgress при первом событии
    await AvenorAPI.addConvertJob(payload);
    // учёт лимита перенесён в onProgress при статусе done
    // noteProUsage("convert");
  } catch (e) {
    console.error("[renderer] addConvertJob failed", e);
    alert("Не удалось добавить задачу на конвертацию");
  }
});

tabSettings?.addEventListener("click", () => setTab("settings"));

function initAccountCard() {
  const emailInput = document.getElementById(
    "settings-email"
  ) as HTMLInputElement | null;
  const checkBtn = document.getElementById(
    "settings-check-license"
  ) as HTMLButtonElement | null;
  const statusEl = document.getElementById(
    "settings-license-status"
  ) as HTMLParagraphElement | null;

  if (!emailInput || !checkBtn || !statusEl) return;

  // если профиль уже есть — показываем email
  if (proState.profile?.email) {
    emailInput.value = proState.profile.email;
  }

  checkBtn.addEventListener("click", async () => {
    const email = emailInput.value.trim().toLowerCase();
    if (!email) {
      statusEl.textContent = "Введите email, который использовали при оплате.";
      return;
    }

    statusEl.textContent = "Проверяю статус…";

    try {
      const profile = await fetchProfileFromBackend(email);

      if (!profile) {
        // подписка не найдена — оставляем free-профиль
        proState.profile = {
          email,
          plan: "free",
          isPro: false,
          proUntil: null,
        };
        statusEl.textContent =
          "Подписка не найдена. Доступен бесплатный режим.";
      } else {
        proState.profile = profile;
        statusEl.textContent = profile.isPro
          ? "Статус: PRO активен."
          : "Статус: Free. Подписка не активна.";
      }

      // 1) сохраняем в license.json через main (правильная форма License)
      try {
        const api: any = (window as any).Avenor;
        const nowIso = new Date().toISOString();

        const planFromProfile: LicensePlanId = proState.profile?.isPro
          ? "pro_month" // или "pro_year" если будешь различать
          : "free";

        const nextLic: Partial<License> = {
          ...(CURRENT_LICENSE || {}), // чтобы не потерять чужие поля
          plan: planFromProfile,
          isPro: !!proState.profile?.isPro,
          email: proState.profile?.email ?? null,
          proUntil: proState.profile?.proUntil ?? null,
          expiresAt: proState.profile?.proUntil ?? null,
          lastCheckedAt: nowIso, // ← ВАЖНО: отметка времени проверки
        };

        const saved = await api?.setLicense?.(nextLic);
        if (saved) {
          CURRENT_LICENSE = saved; // держим в памяти актуальную лицензию
        } else {
          CURRENT_LICENSE = {
            ...(CURRENT_LICENSE || {}),
            ...nextLic,
          } as License;
        }
      } catch (e) {
        console.warn("[profile] setLicense failed", e);
      }

      // 2) дублируем локально как резерв
      saveProfileLocally(proState.profile);

      // 3) обновляем бейджи + флаг IS_PRO
      applyProfileToUI();
    } catch (e) {
      console.error("[profile] check failed", e);
      statusEl.textContent = "Не удалось проверить статус. Попробуйте позже.";
    }
  });
}

function applyConvertI18n() {
  const el = document.getElementById("pickedFileLabelConvert");
  // Меняем текст только если файл ещё не выбран
  if (el && !pickedConvertPath) {
    el.textContent = tr("convert.dropHere");
  }
}

applyConvertI18n(); // первичная установка

// ==== helpers for i18n text ====
function ensureLabelSpan(label: HTMLElement): HTMLSpanElement {
  // убираем «висячие» текстовые узлы, чтобы не было дублей RU+EN
  const rm: ChildNode[] = [];
  label.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) rm.push(n);
  });
  rm.forEach((n) => n.parentNode?.removeChild(n));

  let span = label.querySelector("span");
  if (!span) {
    span = document.createElement("span");
    label.appendChild(span);
  }
  return span as HTMLSpanElement;
}
function setText(el: Element | null, text: string) {
  if (!el) return;
  (el as HTMLElement).textContent = text;
}

// ==== full applyGlobalI18n ====
function applyGlobalI18n() {
  // ---------- Download ----------
  const pasteBtnEl = document.getElementById("pasteBtn");
  setText(pasteBtnEl, tr("download.pasteLink"));

  const audioOnlyLabel = document.getElementById(
    "audioOnlyLabel"
  ) as HTMLElement | null;
  if (audioOnlyLabel) {
    const span = ensureLabelSpan(audioOnlyLabel);
    span.textContent = tr("download.audioOnly");
  }

  const saveBtn = document.getElementById("pickFolder");
  setText(saveBtn, tr("download.saveTo"));

  const qualitySelEl = document.getElementById(
    "quality"
  ) as HTMLSelectElement | null;
  if (qualitySelEl) {
    const q = (LANG[CURRENT_LANG] || LANG.en).download.quality;
    // Дополняем нашими ключами и аккуратно вставляем "Аудио (m4a)" в конец
    const order = [
      "best",
      "8k",
      "4k",
      "2k",
      "1080p",
      "720p",
      "480p",
      "360p",
      "240p",
      "audio", // ← новый пункт
    ] as const;

    const labels: Record<string, string> = {
      audio:
        CURRENT_LANG === "uk"
          ? "Аудіо (m4a)"
          : CURRENT_LANG === "en"
          ? "Audio (m4a)"
          : "Аудио (m4a)",
    };

    qualitySelEl.innerHTML = order
      .map((v) => {
        const label = (q as any)[v] || labels[v] || String(v).toUpperCase();
        return `<option value="${v}">${label}</option>`;
      })
      .join("");
  }

  // пересобираем красивый выпадающий, потому что опции только что перезаписали
  setTimeout(() => {
    try {
      enhanceQualitySelect(true);
    } catch {}
  }, 0);

  // ---------- Compress ----------
  const dropCompressEl = document.getElementById(
    "dropCompress"
  ) as HTMLElement | null;
  if (dropCompressEl) {
    // чистим текстовые узлы и ставим одну строку
    const rm: ChildNode[] = [];
    dropCompressEl.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) rm.push(n);
    });
    rm.forEach((n) => n.parentNode?.removeChild(n));
    let span = dropCompressEl.querySelector("span");
    if (!span) {
      span = document.createElement("span");
      dropCompressEl.appendChild(span);
    }
    span.textContent = tr("compress.dropHere");
  }

  const bySizeLabel = document.querySelector("#cmodeSize")
    ?.parentElement as HTMLElement | null;
  if (bySizeLabel)
    ensureLabelSpan(bySizeLabel).textContent = tr("compress.bySize");

  const byPercentLabel = document.querySelector("#cmodePercent")
    ?.parentElement as HTMLElement | null;
  if (byPercentLabel)
    ensureLabelSpan(byPercentLabel).textContent = tr("compress.byPercent");

  const targetMBEl = document.getElementById(
    "targetMB"
  ) as HTMLInputElement | null;
  if (targetMBEl) targetMBEl.placeholder = tr("compress.sizeMB");

  const targetPercentEl = document.getElementById(
    "targetPercent"
  ) as HTMLInputElement | null;
  if (targetPercentEl)
    targetPercentEl.placeholder = tr("compress.percentOfOriginal");

  const imageSegLabel = document.querySelector("#imageSeg label");
  setText(imageSegLabel, tr("compress.photoFormat"));

  const imageFormatSel = document.getElementById(
    "imageFormat"
  ) as HTMLSelectElement | null;
  if (imageFormatSel) {
    imageFormatSel.innerHTML = `
      <option value="jpeg">${tr("compress.jpeg")}</option>
      <option value="webp">${tr("compress.webp")}</option>
    `;
  }

  const pickFolderCompressBtn = document.getElementById("pickFolderCompress");
  setText(pickFolderCompressBtn, tr("compress.saveTo"));

  const startCompressBtn = document.getElementById("startCompress");
  setText(startCompressBtn, tr("compress.compressBtn"));

  // ← вот эти ДВЕ подписи «Файл не выбран»
  const pickedFileLabel = document.getElementById("pickedFileLabel");
  setText(pickedFileLabel, tr("compress.noFile"));

  // ---------- Convert ----------
  const pickedLblConvert = document.getElementById(
    "pickedFileLabelConvert"
  ) as HTMLElement | null;
  if (pickedLblConvert && !pickedConvertPath) {
    pickedLblConvert.textContent = tr("convert.dropHere");
  }

  // метки и селекты
  const convertTypeLbl =
    document.querySelector('#panel-convert label[for="convertType"]') ||
    document.querySelector("#panel-convert .seg:nth-of-type(2) label");
  setText(convertTypeLbl, tr("convert.type"));

  const targetFormatLbl = document.querySelector(
    "#panel-convert #convertVideoOpts label"
  );
  setText(targetFormatLbl, tr("convert.format"));

  const pickFolderConvertBtn = document.getElementById("pickFolderConvert");
  setText(pickFolderConvertBtn, tr("convert.saveTo"));

  const startConvertBtn = document.getElementById("startConvert");
  setText(startConvertBtn, tr("convert.convertBtn"));

  const convertTypeSel = document.getElementById(
    "convertType"
  ) as HTMLSelectElement | null;
  if (convertTypeSel) {
    const optVideo = convertTypeSel.querySelector('option[value="video"]');
    const optAudio = convertTypeSel.querySelector('option[value="audio"]');
    const optImage = convertTypeSel.querySelector('option[value="image"]');
    setText(optVideo, tr("convert.types.video"));
    setText(optAudio, tr("convert.types.audio"));
    setText(optImage, tr("convert.types.image"));
  }
}

// === Кастомный стеклянный выпадающий список для #quality ===
function enhanceQualitySelect(forceRebuild = false) {
  const sel = document.getElementById("quality") as HTMLSelectElement | null;
  const wrap = sel?.closest(".select-wrap") as HTMLElement | null; // ← так надёжнее
  if (!wrap || !sel) return;

  if ((wrap as any)._enhanced && !forceRebuild) return;

  if ((wrap as any)._enhanced && forceRebuild) {
    wrap.querySelector(".select-trigger")?.remove();
    wrap.querySelector(".select-menu")?.remove();
  }

  (wrap as any)._enhanced = true;
  wrap.classList.add("enhanced");

  // триггер
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "select-trigger";
  trigger.textContent =
    sel.selectedOptions[0]?.text || sel.options[0]?.text || "";
  wrap.appendChild(trigger);

  // меню
  const menu = document.createElement("div");
  menu.className = "select-menu";
  wrap.appendChild(menu);

  const rebuild = () => {
    menu.innerHTML = "";
    Array.from(sel.options).forEach((opt) => {
      const item = document.createElement("div");
      item.className = "select-option";
      item.textContent = opt.text;
      item.dataset.value = opt.value;
      if (opt.selected) item.setAttribute("aria-selected", "true");
      item.onclick = () => {
        sel.value = opt.value;
        trigger.textContent = opt.text;
        Array.from(menu.children).forEach((ch) =>
          ch.removeAttribute("aria-selected")
        );
        item.setAttribute("aria-selected", "true");
        menu.classList.remove("open");
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      };
      menu.appendChild(item);
    });
  };
  rebuild();

  // открыть/закрыть
  const toggleMenu = () => menu.classList.toggle("open");
  trigger.addEventListener("click", toggleMenu);
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target as Node)) menu.classList.remove("open");
  });

  // если значение поменяли кодом
  sel.addEventListener("change", () => {
    const t = sel.selectedOptions[0]?.text || "";
    trigger.textContent = t;
    Array.from(menu.children).forEach((ch) => {
      const el = ch as HTMLElement;
      el.toggleAttribute("aria-selected", el.dataset.value === sel.value);
    });
  });
}

// === ИНИЦИАЛИЗАЦИЯ НАСТРОЕК ДЛЯ ТВОЕЙ РАЗМЕТКИ (БЕЗ ЯЗЫКОВ) ===
document.addEventListener("DOMContentLoaded", async () => {
  try {
    const api: any = (window as any).Avenor;

    // загружаем настройки и версию
    const s = await api.getSettings();
    SETTINGS_STATE = s;
    // фиксируем язык на русском, не читаем и не меняем его через настройки
    CURRENT_LANG = "ru";

    // путь загрузки
    const pathSpan = document.getElementById(
      "settings-download-path"
    ) as HTMLSpanElement | null;
    if (pathSpan && s.downloadDir) {
      pathSpan.textContent = s.downloadDir;
    }

    // чекбоксы звука
    const soundDone = document.getElementById(
      "settings-sound-done"
    ) as HTMLInputElement | null;
    const soundError = document.getElementById(
      "settings-sound-error"
    ) as HTMLInputElement | null;
    if (soundDone) soundDone.checked = !!s.soundDoneEnabled;
    if (soundError) soundError.checked = !!s.soundErrorEnabled;

    if (soundDone) {
      soundDone.addEventListener("change", () => {
        SETTINGS_STATE = {
          ...(SETTINGS_STATE || s),
          soundDoneEnabled: soundDone.checked,
        };
      });
    }

    if (soundError) {
      soundError.addEventListener("change", () => {
        SETTINGS_STATE = {
          ...(SETTINGS_STATE || s),
          soundErrorEnabled: soundError.checked,
        };
      });
    }

    // версия
    const verSpan = document.getElementById(
      "settings-version"
    ) as HTMLSpanElement | null;
    try {
      const ver = await api.getVersion();
      if (verSpan) verSpan.textContent = ver;
    } catch {}

    // --- Автообновление ---
    const checkUpdatesBtn = document.getElementById(
      "settings-check-updates"
    ) as HTMLButtonElement | null;
    const updateStatusEl = document.getElementById(
      "settings-update-status"
    ) as HTMLParagraphElement | null;

    if (checkUpdatesBtn && updateStatusEl) {
      checkUpdatesBtn.disabled = false; // снимаем disabled из HTML

      checkUpdatesBtn.addEventListener("click", async () => {
        if (!api.checkUpdates) {
          updateStatusEl.textContent = "Обновления не настроены.";
          return;
        }

        const oldText = checkUpdatesBtn.textContent || "Проверить обновления";
        checkUpdatesBtn.disabled = true;
        checkUpdatesBtn.textContent = "Проверяю…";

        const currentVer = verSpan?.textContent?.trim();
        updateStatusEl.textContent = currentVer
          ? `Текущая версия: ${currentVer}. Идёт проверка обновлений…`
          : "Идёт проверка обновлений…";

        try {
          const res = await api.checkUpdates();
          let msg = "";

          if (typeof res === "string") {
            // на всякий случай поддерживаем строковый ответ
            msg = res;
          } else if (res && typeof res === "object") {
            const status = (res as any).status;
            const cur =
              (res as any).currentVersion ?? (res as any).current ?? null;
            const latest =
              (res as any).latestVersion ?? (res as any).latest ?? null;
            const version =
              (res as any).version || latest || (res as any).newVersion || "";

            if ((res as any).message) {
              // если main вернул человеко-читаемое сообщение — просто показываем его
              msg = (res as any).message;
            } else if (status === "dev-skip") {
              // 🔹 наш новый случай для dev-режима
              msg =
                "Проверка обновлений доступна только в установленной версии Avenor Downloader.";
            } else if (status === "no-update") {
              msg =
                cur && latest
                  ? `Установлена последняя версия (${cur}).`
                  : "Установлена последняя версия.";
            } else if (status === "available") {
              msg = version
                ? `Найдена новая версия ${version}, идёт загрузка…`
                : "Найдена новая версия, идёт загрузка…";
            } else if (status === "downloaded") {
              // 🔥 КЛЮЧЕВОЙ БЛОК — предлагать установить
              if (api.installUpdate) {
                const vLabel = version || "обновление";
                const ok = window.confirm(
                  `Обновление ${vLabel} уже загружено.\n\nУстановить сейчас? Приложение будет перезапущено.`
                );
                if (ok) {
                  await api.installUpdate();
                  msg = "Устанавливаю обновление…";
                } else {
                  msg =
                    "Обновление загружено, установку можно выполнить позже из этого окна.";
                }
              } else {
                msg = version
                  ? `Новая версия ${version} загружена. Перезапусти приложение для установки.`
                  : "Новая версия загружена. Перезапусти приложение для установки.";
              }
            } else {
              msg = "Не удалось проверить обновления.";
            }

            if (cur && verSpan) verSpan.textContent = cur;
          }
          

          updateStatusEl.textContent = msg;
        } catch (e) {
          console.error("[settings] checkUpdates failed", e);
          updateStatusEl.textContent = "Ошибка при проверке обновлений.";
        } finally {
          checkUpdatesBtn.disabled = false;
          checkUpdatesBtn.textContent = oldText;
        }
      });
    }


    // кнопка "Выбрать" путь загрузки
    const pickPathBtn = document.getElementById(
      "settings-pick-path"
    ) as HTMLButtonElement | null;
    pickPathBtn?.addEventListener("click", async () => {
      const dir = await api.pickDownloadDir();
      if (dir && pathSpan) {
        pathSpan.textContent = dir;
      }
    });

    // очистка истории (по типам + статус)
    const historyStatus = document.getElementById(
      "settings-history-status"
    ) as HTMLParagraphElement | null;

    function setHistoryStatus(scope: string, ok: boolean) {
      if (!historyStatus) return;

      let text = "";
      if (!ok) {
        text = "Не удалось очистить историю. Попробуй ещё раз.";
      } else {
        switch (scope) {
          case "download":
            text = "История скачиваний очищена.";
            break;
          case "compress":
            text = "История сжатия очищена.";
            break;
          case "convert":
            text = "История конвертаций очищена.";
            break;
          case "all":
          default:
            text = "Вся история очищена.";
            break;
        }
      }

      historyStatus.textContent = text;

      if (text) {
        setTimeout(() => {
          if (historyStatus.textContent === text) {
            historyStatus.textContent = "";
          }
        }, 2500);
      }
    }

    function removeHistoryCardsFromDom(scope: string) {
      const cards = document.querySelectorAll<HTMLDivElement>(".job-card");

      cards.forEach((card) => {
        const jt = (card.dataset && card.dataset.jobType) || "";

        if (
          scope === "all" ||
          (scope === "download" && jt === "download") ||
          (scope === "compress" && jt === "compress") ||
          (scope === "convert" && jt === "convert")
        ) {
          card.remove();
        }
      });

      (window as any).AvenorUI?.refreshEmptyState?.();
    }

    const historyButtons = document.querySelectorAll<HTMLButtonElement>(
      "[id^='settings-clear-history-']"
    );

    historyButtons.forEach((btn) => {
      const scope =
        (btn.dataset.scope as "all" | "download" | "compress" | "convert") ||
        "all";

      btn.addEventListener("click", async () => {
        try {
          const res = await api.clearHistory(scope);
          const ok = !res || (res as any).ok !== false;

          if (ok) {
            removeHistoryCardsFromDom(scope);
          }

          setHistoryStatus(scope, ok);
        } catch (e) {
          console.warn("[renderer] clearHistory failed", e);
          setHistoryStatus(scope, false);
        }
      });
    });

    // тест звуков
    const testDoneBtn = document.getElementById(
      "settings-test-done"
    ) as HTMLButtonElement | null;
    const testErrorBtn = document.getElementById(
      "settings-test-error"
    ) as HTMLButtonElement | null;

    testDoneBtn?.addEventListener("click", () => {
      if (!soundDone?.checked || !SFX.done) return;
      new Audio(SFX.done).play().catch(() => {});
    });

    testErrorBtn?.addEventListener("click", () => {
      if (!soundError?.checked || !SFX.error) return;
      new Audio(SFX.error).play().catch(() => {});
    });

    // кнопка "Сохранить настройки" (без языка)
    const saveBtn = document.getElementById(
      "settings-save"
    ) as HTMLButtonElement | null;
    const saveStatusEl = document.getElementById(
      "settings-save-status"
    ) as HTMLParagraphElement | null;

    saveBtn?.addEventListener("click", async () => {
      if (!saveBtn) return;

      const next = {
        downloadDir: pathSpan?.textContent?.trim() || s.downloadDir,
        soundDoneEnabled: !!soundDone?.checked,
        soundErrorEnabled: !!soundError?.checked,
      };

      // состояние "сохраняем"
      saveBtn.classList.remove("saved");
      saveBtn.classList.add("saving");
      saveBtn.disabled = true;

      if (saveStatusEl) {
        saveStatusEl.textContent = "";
        saveStatusEl.classList.remove("visible");
      }

      try {
        SETTINGS_STATE = await api.setSettings(next);

        // успех
        saveBtn.classList.remove("saving");
        saveBtn.classList.add("saved");

        if (saveStatusEl) {
          saveStatusEl.textContent = "Настройки сохранены";
          saveStatusEl.classList.add("visible");
        }

        // через 1.5 сек убираем подсветку, но текст можно оставить или скрыть
        setTimeout(() => {
          saveBtn.classList.remove("saved");
          saveBtn.disabled = false;

          if (
            saveStatusEl &&
            saveStatusEl.textContent === "Настройки сохранены"
          ) {
            saveStatusEl.classList.remove("visible");
            // если хочешь, можешь очистить текст:
            // saveStatusEl.textContent = "";
          }
        }, 1500);
      } catch (e) {
        console.warn("[renderer] setSettings failed", e);
        saveBtn.classList.remove("saving");
        saveBtn.disabled = false;

        if (saveStatusEl) {
          saveStatusEl.textContent = "Не удалось сохранить настройки";
          saveStatusEl.classList.add("visible");
        }
      }
    });
  } catch (e) {
    console.warn("[renderer] settings init failed", e);
  }
});

function buildThumbFallbacks(url: string): string[] {
  // Универсальный фолбэк: если это YouTube — перечислим стандартные пресеты;
  // иначе вернём только исходный url.
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const list: string[] = [];

    if (host.includes("ytimg.com")) {
      // youtube: меняем имя файла и расширение (webp -> jpg) по очереди
      const names = [
        "maxresdefault",
        "sddefault",
        "hqdefault",
        "mqdefault",
        "default",
      ];
      const isWebp = u.pathname.endsWith(".webp");
      for (const n of names) {
        const p1 = u.pathname.replace(
          /[^/]+$/,
          `${n}${isWebp ? ".webp" : ".jpg"}`
        );
        list.push(`${u.origin}${p1}`);
        // дубль с .jpg на случай, если .webp нет
        const p2 = u.pathname.replace(/[^/]+$/, `${n}.jpg`);
        if (!list.includes(`${u.origin}${p2}`)) list.push(`${u.origin}${p2}`);
      }
      return list;
    }
    // не YouTube — отдаем как есть
    return [url];
  } catch {
    return [url];
  }
}
