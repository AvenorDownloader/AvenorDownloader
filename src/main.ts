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

function setupUpdates(mainWindow: BrowserWindow) {
  const isDev = !app.isPackaged;

  // Для логики: в dev просто сразу отвечаем что проверки нет
  if (isDev) {
    ipcMain.handle("updates:check", async () => {
      console.log(
        "[updates] Dev mode: skip checkForUpdates (app is not packaged)"
      );
      return {
        ok: false,
        dev: true,
        status: "dev-skip",
        message:
          "Проверка обновлений работает только в установленной версии Avenor Downloader.",
        currentVersion: app.getVersion(),
      };
    });

    ipcMain.handle("updates:install", async () => {
      // В dev ничего не устанавливаем
      return { ok: false, dev: true };
    });

    return;
  }

  // ===== PROD-ВЕТКА =====
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // События автообновления → шлём их в renderer
  autoUpdater.on("update-available", (info) => {
    console.log("[updates] update-available:", info.version);
    mainWindow.webContents.send("updates:event", {
      type: "available",
      version: info.version,
    });
  });

  autoUpdater.on("download-progress", (p) => {
    const payload = {
      percent: p.percent, // проценты
      transferred: p.transferred, // сколько байт скачано
      total: p.total, // общий размер
      bytesPerSecond: p.bytesPerSecond, // скорость
    };

    console.log("[updates] download-progress:", payload);
    mainWindow.webContents.send("updates:progress", payload);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[updates] update-downloaded:", info.version);
    mainWindow.webContents.send("updates:event", {
      type: "downloaded",
      version: info.version,
    });
  });

  autoUpdater.on("error", (err) => {
    console.error("[updates] error:", err);
    mainWindow.webContents.send("updates:event", {
      type: "error",
      message: err?.message || String(err),
    });
  });

  // Основной хендлер, который дергает кнопка "Проверить обновления"
  ipcMain.handle("updates:check", async () => {
    try {
      console.log("[updates] checkForUpdates()...");
      const result = await autoUpdater.checkForUpdates();
      const currentVersion = app.getVersion();

      if (!result || !result.updateInfo) {
        return {
          ok: true,
          status: "no-update",
          currentVersion,
          latestVersion: currentVersion,
          message: "",
        };
      }

      const info = result.updateInfo;
      const latest = info.version || currentVersion;

      if (latest === currentVersion) {
        return {
          ok: true,
          status: "no-update",
          currentVersion,
          latestVersion: latest,
          message: "",
        };
      }

      // Если нашли новую версию — autoUpdater сам начнёт качать
      return {
        ok: true,
        status: "available",
        currentVersion,
        latestVersion: latest,
        version: latest,
        message: "",
      };
    } catch (err: any) {
      console.error("[updates] Error in checkForUpdates:", err);
      return {
        ok: false,
        status: "error",
        currentVersion: app.getVersion(),
        message: err?.message || "Не удалось проверить обновления.",
      };
    }
  });

  // Хендлер установки (renderer вызывает api.installUpdate())
  ipcMain.handle("updates:install", async () => {
    try {
      console.log("[updates] quitAndInstall()");
      // Эта функция сама закрывает приложение и ставит обновление
      autoUpdater.quitAndInstall();
      return { ok: true };
    } catch (err: any) {
      console.error("[updates] Error in quitAndInstall:", err);
      return {
        ok: false,
        message: err?.message || "Не удалось установить обновление.",
      };
    }
  });
}

// === END AUTO-UPDATE SETUP ===


function createWindow(): BrowserWindow {
  const mainWin = new BrowserWindow({
    width: 874,
    height: 701,
    minWidth: 874,
    minHeight: 701,
    backgroundColor: "#111214",
    icon: ICON_PATH,

    frame: true,
    autoHideMenuBar: true,
    transparent: false,
    hasShadow: true,
    roundedCorners: true,
    titleBarOverlay: false,

    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win = mainWin; // обновляем глобальную ссылку

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
        { role: "reload", accelerator: "CmdOrCtrl+R" },
        { role: "forceReload", accelerator: "CmdOrCtrl+Shift+R" },
        { type: "separator" },
        { role: "toggleDevTools", accelerator: "CmdOrCtrl+Shift+I" },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  mainWin.on("maximize", () =>
    mainWin.webContents.send("win:state", { isMaximized: true })
  );
  mainWin.on("unmaximize", () =>
    mainWin.webContents.send("win:state", { isMaximized: false })
  );

  mainWin.setMinimumSize(739, 682);

  const indexPath = path.join(__dirname, "..", "index.html");
  console.log("[main] loading index from", indexPath);
  mainWin.loadFile(indexPath);

  return mainWin;
}




app.whenReady().then(() => {
  // 1) регистрируем IPC-обработчики лицензии
  registerLicenseIpc();

  // 2) создаём окно
  const mainWindow = createWindow();

  // 3) запускаем систему автообновлений (наш новый setupUpdates)
  setupUpdates(mainWindow);
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
