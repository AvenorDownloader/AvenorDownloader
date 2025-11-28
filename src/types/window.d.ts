export {};

// тот же формат плана лицензии, что и в renderer.ts / licenseService.ts
type LicensePlanId = "free" | "pro_month" | "pro" | "pro_year";

type RendererLicense = {
  plan: LicensePlanId;
  isPro: boolean;
  expiresAt: string | null;
  lastCheckedAt?: string | null;

  // поля, которые прилетают из Supabase / backend
  email?: string | null;
  proUntil?: string | null;
};

// Стадии задач (скачка / сжатие / конвертация)
type JobStage =
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

type JobProgress = {
  id: string;
  stage: JobStage;
  percent?: number;
  downloadedMB?: number;
  totalMB?: number;
  speed?: string;
  eta?: string;
  filepath?: string;
  source?: "download" | "compress" | "convert";
  meta?: any;
  message?: string;
};

// Результат проверки обновлений
type UpdateCheckResult = {
  status:
    | "dev-skip" // разработческий режим, автообновления выключены
    | "no-update" // обновлений нет
    | "available" // обновление найдено, идёт загрузка
    | "downloaded" // обновление скачано
    | "error"; // ошибка

  currentVersion?: string;
  latestVersion?: string;
  version?: string; // новая версия, если есть
  message?: string; // человекочитаемый текст
  error?: string;
};

// Основной мост с main/preload для renderer.ts
type AvenorApi = {
  // === Очереди задач ===
  addJob(p: any): Promise<string>;
  addCompressJob(p: any): Promise<string>;
  addConvertJob(p: any): Promise<string>;

  // прогресс задач (подписка)
  onProgress(cb: (p: JobProgress) => void): void | (() => void);

  // === Файловые диалоги ===
  pickFolder(): Promise<string | null>;
  pickDownloadDir?(): Promise<string | null>;

  // === Управление задачами ===
  cancelJob?(id: string): Promise<boolean>;
  removeJob?(id: string): Promise<boolean>;

  // === Файловая система ===
  revealInFolder(filePath: string): Promise<boolean>;

  // === SETTINGS ===
  getSettings(): Promise<any>;
  setSettings(partial: any): Promise<any>;

  // === HISTORY ===
  getHistory(): Promise<any[]>;
  historyRemove(id: string): Promise<void>;
  clearHistory(
    scope?: "all" | "download" | "compress" | "convert"
  ): Promise<{ ok?: boolean } | void>;

  // === APP / ресурсы ===
  getVersion(): Promise<string>;
  getAssetUrl(rel: string): Promise<string>;
  openExternal(url: string): Promise<boolean | void>;

  // === ЛИЦЕНЗИЯ / PRO ===
  getLicense?(): Promise<RendererLicense>;
  setLicense?(partial: Partial<RendererLicense>): Promise<RendererLicense>;

  // === АВТООБНОВЛЕНИЯ ===
  checkUpdates?(): Promise<UpdateCheckResult | string>;
  installUpdate?(): Promise<void>;

  // прогресс загрузки обновления
  onUpdateProgress?(
    cb: (p: {
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }) => void
  ): () => void;

  // события обновления (available / downloaded / error)
  onUpdateEvent?(
    cb: (e: { type: string; version?: string; message?: string }) => void
  ): () => void;
};

declare global {
  interface Window {
    Avenor: AvenorApi;

    AvenorWindow?: {
      minimize(): void;
      toggleMaximize(): void;
      close(): void;
      getState(): Promise<{ isMaximized: boolean }>;
      onState?(cb: (s: { isMaximized: boolean }) => void): () => void;
    };

    // не обязательно, но если хочешь — можно ещё так подсказать:
    // AvenorUI?: {
    //   refreshEmptyState?: () => void;
    // };
  }
}
