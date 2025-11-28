import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from "electron";
import { autoUpdater } from "electron-updater";
import path from "path";
import fs from "fs";
import { AddJobPayload, JobProgress } from "./types";
import { DownloadQueue } from "./queue";
import * as CompressMod from "./compressQueue";
import * as ConvertMod from "./convertQueue";
import { pathToFileURL } from "url";
import { registerLicenseIpc } from "./licenseService";


function resolveCtor(mod: any, name: string) {
  const cand =
    (typeof mod === "function" && mod) ||
    (mod?.default && typeof mod.default === "function" && mod.default) ||
    (mod?.[name] && typeof mod[name] === "function" && mod[name]) ||
    (typeof mod?.createQueue === "function" && mod.createQueue) ||
    (typeof mod?.create === "function" && mod.create);

  if (!cand) throw new Error(`[main] ${name} not found`);

  // Вернём ОБЕРТКУ: можно просто вызвать без `new`
  return (send: any, opts: any) => {
    try {
      return new (cand as any)(send, opts);
    } catch {
      return (cand as any)(send, opts);
    }
  };
}

function resolveResource(rel: string) {
  const dev = path.join(process.cwd(), "resources", rel);
  const prod = path.join(process.resourcesPath, rel);
  return fs.existsSync(dev) ? dev : prod;
}

// ▼ SETTINGS storage
const USER_DIR = app.getPath("userData");
const SETTINGS_DIR = path.join(USER_DIR, "Settings");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");
const HISTORY_FILE = path.join(USER_DIR, "history.json");

const DEFAULT_SETTINGS = {
  downloadDir: path.join(USER_DIR, "Avenor", "Downloads"),
  soundDoneEnabled: true,
  soundErrorEnabled: true,
  language: "ru" as "ru" | "uk" | "en",
  autoUpdate: false,
};


type HistoryItem = {
  id: string;
  ts: number; // время добавления
  source?: "download" | "compress" | "convert";
  kind?: "video" | "audio" | "other";
  stage: JobProgress["stage"];
  meta?: JobProgress["meta"];
  filepath?: string;
  title?: string;
  thumb?: string; // ← URL/путь к превью
};


function loadHistory(): HistoryItem[] {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveHistory(list: HistoryItem[]) {
  ensureDir(path.dirname(HISTORY_FILE));
  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(list.slice(-300), null, 2),
    "utf8"
  );
}
function upsertHistory(p: JobProgress) {
  const list = loadHistory();
  const i = list.findIndex((x) => x.id === p.id);
  const prev = i >= 0 ? list[i] : undefined;

  // meta из прогресса (для download/convert/compress они разные)
  const meta: any = p.meta ?? {};

  // превью: берём из meta, иначе оставляем старое
  const thumbFromMeta =
    meta.thumb ||
    meta.thumbnail || // yt-dlp часто кладёт сюда
    meta.thumbUrl ||
    meta.preview ||
    meta.previewUrl;

  // пробуем определить тип файла
  const extFromMeta = (meta.ext || meta.extension || "")
    .toString()
    .toLowerCase();
  const extFromPath =
    (p.filepath && path.extname(p.filepath).slice(1).toLowerCase()) || "";
  const ext = extFromMeta || extFromPath;

  const isVideo =
    !!meta.vcodec ||
    !!meta.resolution ||
    meta.isVideo === true ||
    ["mp4", "mov", "mkv", "webm", "avi", "flv", "gif"].includes(ext);

  const isAudio =
    !!meta.acodec ||
    meta.isAudio === true ||
    ["mp3", "m4a", "aac", "ogg", "opus", "flac", "wav"].includes(ext);

  const next: HistoryItem = {
    id: p.id,
    ts: prev ? prev.ts : Date.now(),

    // источник: download / compress / convert
    source:
      (p as any).source ??
      (meta.jobType as any) ?? // для convert/compress
      prev?.source ??
      "download",

    // тип: видео/аудио/прочее — теперь корректно и для сжатия/конвертации
    kind: isVideo ? "video" : isAudio ? "audio" : prev?.kind || "other",

    stage: p.stage,
    meta: p.meta ?? (prev as any)?.meta,
    filepath: p.filepath || prev?.filepath,
    title: meta.title || prev?.title,
    thumb: thumbFromMeta || prev?.thumb,
  };

  if (i >= 0) list[i] = next;
  else list.unshift(next);

  saveHistory(list);
}



function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function readJSON(file: string, fallback: any) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(file: string, data: any) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function loadSettings() {
  ensureDir(SETTINGS_DIR);
  const raw = readJSON(SETTINGS_FILE, DEFAULT_SETTINGS);
  const s = { ...DEFAULT_SETTINGS, ...raw };

  // гарантируем, что папка загрузок есть
  if (s.downloadDir) {
    ensureDir(s.downloadDir);
  }

  // миграция со старого поля
  if (raw.soundEnabled !== undefined) {
    if (s.soundDoneEnabled === undefined)
      s.soundDoneEnabled = !!raw.soundEnabled;
    if (s.soundErrorEnabled === undefined)
      s.soundErrorEnabled = !!raw.soundEnabled;
  }
  delete (s as any).soundEnabled;
  delete (s as any).soundFile;

  return s;
}



function saveSettings(next: any) {
  const merged = { ...DEFAULT_SETTINGS, ...next };
  writeJSON(SETTINGS_FILE, merged);
  return merged;
}

console.log("[main] preload at", path.join(__dirname, "preload.js"));

const ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");
let win: BrowserWindow | null = null;


// === AUTO-UPDATE SETUP ===
function initAutoUpdate() {
  // можно включить лог, если хочешь видеть, что происходит
  // autoUpdater.logger = console as any;

  autoUpdater.autoDownload = true;          // сразу качаем обнову
  autoUpdater.autoInstallOnAppQuit = true;  // ставим при выходе из приложения

  autoUpdater.on("update-available", () => {
    console.log("[update] available");
    if (win && !win.isDestroyed()) {
      win.webContents.send("update-available");
    }
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[update] not available");
    if (win && !win.isDestroyed()) {
      win.webContents.send("update-not-available");
    }
  });

  autoUpdater.on("update-downloaded", () => {
    console.log("[update] downloaded");
    if (win && !win.isDestroyed()) {
      win.webContents.send("update-downloaded");
    }
  });

  autoUpdater.on("error", (err) => {
    console.error("[update] error:", err);
    if (win && !win.isDestroyed()) {
      win.webContents.send("update-error", String(err));
    }
  });

  // стартуем первую проверку
  autoUpdater.checkForUpdatesAndNotify();
}
// === END AUTO-UPDATE SETUP ===

function createWindow() {
  win = new BrowserWindow({
    width: 874,
    height: 701,
    minWidth: 874,
    minHeight: 701,
    backgroundColor: "#111214",
    icon: ICON_PATH,

    frame: true,
    autoHideMenuBar: true, // ← отключаем системную рамку и кнопки
    transparent: false,
    hasShadow: true,
    roundedCorners: true,
    titleBarOverlay: false, // на всякий случай, чтобы ничего не рисовало сверху

    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // ===== Минимальное меню, чтобы работали Ctrl+R и Ctrl+Shift+I =====
  const isMac = process.platform === "darwin";

  const template: any[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "View",
      submenu: [
        {
          role: "reload", // перезагрузка
          accelerator: "CmdOrCtrl+R",
        },
        {
          role: "forceReload", // жёсткая перезагрузка
          accelerator: "CmdOrCtrl+Shift+R",
        },
        { type: "separator" },
        {
          role: "toggleDevTools", // DevTools
          accelerator: "CmdOrCtrl+Shift+I",
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // сообщаем рендеру, развернуто окно или нет
  win.on("maximize", () =>
    win?.webContents.send("win:state", { isMaximized: true })
  );
  win.on("unmaximize", () =>
    win?.webContents.send("win:state", { isMaximized: false })
  );

  win.setMinimumSize(739, 682);

  // В dev и в проде путь собираем от dist/main.js -> ../index.html
  const indexPath = path.join(__dirname, "..", "index.html");
  console.log("[main] loading index from", indexPath);

  win.loadFile(indexPath);
}



app.whenReady().then(() => {
  // 1) регистрируем IPC-обработчики лицензии
  registerLicenseIpc();

  // 2) создаём окно как раньше
  createWindow();

  // 3) запускаем систему автообновлений
  initAutoUpdate();
});


app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

const sendProgress = (p: JobProgress) => {
  try {
    if (win && !win.isDestroyed()) {
      console.log("[M]", p.stage, p.percent);
      win.webContents.send("job-progress", p);
    }
  } catch (e) {
    console.warn("[job-progress] drop (window not ready)", e);
  }

  // <-- сохраняем историю на каждом апдейте (и при done, и при error и т.д.)
  try {
    upsertHistory(p);
  } catch (e) {
    console.warn("[history] upsert failed:", e);
  }
};

const queue = new DownloadQueue(sendProgress);

let cqueue: any;
let vqueue: any;

try {
  const makeCompressQueue = resolveCtor(CompressMod, "CompressQueue");
  cqueue = makeCompressQueue(sendProgress, { concurrency: 5 });
} catch (e) {
  console.error("[main] compress queue unavailable:", e);
  cqueue = {
    add: async () => {
      throw new Error("Compress queue is not available");
    },
  };
}

try {
  const makeConvertQueue = resolveCtor(ConvertMod, "ConvertQueue");
  vqueue = makeConvertQueue(sendProgress, { concurrency: 3 });
} catch (e) {
  console.error("[main] convert queue unavailable:", e);
  vqueue = {
    add: async () => {
      throw new Error("Convert queue is not available");
    },
  };
}
ipcMain.handle("convert:add", async (_evt, payload) => {
  return vqueue.add(payload);
});

ipcMain.handle("pick-folder", async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
});

ipcMain.handle("add-job", async (_evt, payload: AddJobPayload) => {
  return queue.add(payload, () => {});
});

ipcMain.handle("compress:add", async (_evt, payload) => {
  return cqueue.add(payload);
});

ipcMain.handle("reveal-in-folder", async (_evt, filePath: string) => {
  try {
    if (!filePath) return false;
    // подчищаем кавычки/пробелы и нормализуем для Windows
    const p = path.normalize(String(filePath).trim().replace(/^"|"$/g, ""));
    if (!fs.existsSync(p)) {
      console.warn("[reveal-in-folder] not exists:", p);
      return false;
    }
    // Explorer откроется и ВЫДЕЛИТ файл
    shell.showItemInFolder(p);
    return true;
  } catch (err) {
    console.error("[reveal-in-folder] error:", err);
    return false;
  }
});

ipcMain.handle("avenor:cancel", async (_e, id: string) => {
  let ok = false;

  if (queue?.cancel) {
    ok = queue.cancel(id) || ok;
  }
  if (cqueue?.cancel) {
    ok = cqueue.cancel(id) || ok;
  }
  if (vqueue?.cancel) {
    ok = vqueue.cancel(id) || ok;
  }

  return ok;
});


ipcMain.handle("avenor:remove", async (_e, id: string) => {
  return queue.remove?.(id) ?? true; // опционально: подчистка истории
});

// ===== SETTINGS IPC =====
ipcMain.handle("settings:get", async () => {
  return loadSettings();
});

ipcMain.handle("settings:set", async (_e, partial) => {
  return saveSettings(partial || {});
});

ipcMain.handle("settings:pickDownloadDir", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || !res.filePaths?.[0]) return null;
  const dir = res.filePaths[0];
  const s = saveSettings({ ...loadSettings(), downloadDir: dir });
  return s.downloadDir;
});

// ===== APP (версия и обновления) =====
ipcMain.handle("app:getVersion", async () => app.getVersion());

// Ручная проверка обновлений по кнопке "Проверить обновления"
ipcMain.handle("app:checkUpdates", async () => {
  try {
    const result = await autoUpdater.checkForUpdates();

    // если обновления нет — result может быть null/undefined
    if (!result || !result.updateInfo) {
      return {
        available: false,
        currentVersion: app.getVersion(),
      };
    }

    return {
      available: true,
      currentVersion: app.getVersion(),
      latestVersion: result.updateInfo.version,
    };
  } catch (err) {
    console.error("[app:checkUpdates] error:", err);
    return {
      available: false,
      currentVersion: app.getVersion(),
      error: String(err),
    };
  }
});

// Установка скачанного обновления по кнопке "Установить и перезапустить"
ipcMain.handle("app:installUpdate", async () => {
  try {
    autoUpdater.quitAndInstall();
    return { ok: true };
  } catch (err) {
    console.error("[app:installUpdate] error:", err);
    return { ok: false, error: String(err) };
  }
});


// перед регистрацией снимаем старый обработчик, если он был
ipcMain.removeHandler("app:openExternal");
ipcMain.handle("app:openExternal", async (_e, url: string) => {
  try {
    if (!url || typeof url !== "string") return false;
    await shell.openExternal(url);
    return true;
  } catch (err) {
    console.error("[app:openExternal] failed:", err);
    return false;
  }
});


// ===== HISTORY =====
ipcMain.handle(
  "history:clear",
  async (
    _e,
    scope?: "all" | "download" | "compress" | "convert"
  ) => {
    try {
      // если scope не передан или "all" — ведём себя как раньше: чистим весь файл
      if (!scope || scope === "all") {
        if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
        return { ok: true };
      }

      // частичная очистка по типу
      const list = loadHistory();
      const filtered = list.filter((item) => item.source !== scope);
      saveHistory(filtered);

      return { ok: true };
    } catch (e) {
      console.warn("[history:clear] failed:", e);
      return { ok: false, error: String(e) };
    }
  }
);


ipcMain.handle("app:getAssetUrl", async (_e, rel: string) => {
  const p = resolveResource(rel); // например "sfx/done.wav"
  return pathToFileURL(p).href; // вернёт file:///…/done.wav
});

// ===== HISTORY IPC =====
ipcMain.handle("history:get", async () => {
  try {
    return loadHistory();
  } catch (e) {
    console.warn("[history:get] failed:", e);
    return [];
  }
});

ipcMain.handle("history:remove", async (_e, id: string) => {
  try {
    const list = loadHistory().filter((x) => x.id !== id);
    saveHistory(list);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("win:minimize", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.minimize();
});

ipcMain.handle("win:toggleMaximize", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});

ipcMain.handle("win:close", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.close();
});

ipcMain.handle("win:getState", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return { isMaximized: !!w?.isMaximized() };
});
