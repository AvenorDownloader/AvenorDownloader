/// <reference path="./types/window.d.ts" />

import { contextBridge, ipcRenderer } from "electron";
import type { JobProgress, AddJobPayload } from "./types";

contextBridge.exposeInMainWorld("Avenor", {
  addJob: (p: AddJobPayload) => ipcRenderer.invoke("add-job", p),

  addCompressJob: (p: any) => ipcRenderer.invoke("compress:add", p),
  addConvertJob: (payload: any) => ipcRenderer.invoke("convert:add", payload),

  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  cancelJob: (id: string) => ipcRenderer.invoke("avenor:cancel", id),
  removeJob: (id: string) => ipcRenderer.invoke("avenor:remove", id),

  revealInFolder: (filePath: string) =>
    ipcRenderer.invoke("reveal-in-folder", filePath),

  // ▼ SETTINGS
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (partial: any) => ipcRenderer.invoke("settings:set", partial),
  pickDownloadDir: () => ipcRenderer.invoke("settings:pickDownloadDir"),
  // ▼ APP
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  getAssetUrl: (rel: string) => ipcRenderer.invoke("app:getAssetUrl", rel),

  checkUpdates: () => ipcRenderer.invoke("app:checkUpdates"),

  // ▼ HISTORY
  getHistory: () => ipcRenderer.invoke("history:get"),
  historyRemove: (id: string) => ipcRenderer.invoke("history:remove", id),
  clearHistory: (scope?: "all" | "download" | "compress" | "convert") =>
    ipcRenderer.invoke("history:clear", scope),

  // ▼ LICENSE
  getLicense: () => ipcRenderer.invoke("license:get"),
  setLicense: (partial: any) => ipcRenderer.invoke("license:set", partial),

  // ▼ OPEN EXTERNAL (для paywall / сайта)
  openExternal: (url: string) => ipcRenderer.invoke("app:openExternal", url),

  onProgress: (cb: (p: JobProgress) => void) => {
    const listener = (_e: any, p: JobProgress) => {
      console.log("[preload] progress:", p.stage, p.percent, p.filepath);
      cb(p);
    };
    ipcRenderer.removeAllListeners("job-progress");
    ipcRenderer.on("job-progress", listener);
    return () => ipcRenderer.off("job-progress", listener);
  },
});

// === Window controls API (custom titlebar) ===
contextBridge.exposeInMainWorld("AvenorWindow", {
  minimize: () => ipcRenderer.invoke("win:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("win:toggleMaximize"),
  close: () => ipcRenderer.invoke("win:close"),
  getState: () => ipcRenderer.invoke("win:getState"),

  // (необязательно) подпишемся на изменения состояния окна — чтобы
  // можно было менять иконку «развернуть/восстановить» в UI
  onState: (cb: (state: { isMaximized: boolean }) => void) => {
    const listener = (_e: any, payload: { isMaximized: boolean }) =>
      cb(payload);
    ipcRenderer.on("win:state", listener);
    return () => ipcRenderer.off("win:state", listener);
  },
});
