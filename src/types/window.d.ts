export {};

// тот же формат лицензии, что и используем в renderer/licenseService
type LicensePlanId = "free" | "pro_month" | "pro" | "pro_year";

type RendererLicense = {
  plan: LicensePlanId;
  isPro: boolean;
  expiresAt: string | null;
  lastCheckedAt?: string | null;
  email?: string | null;
  proUntil?: string | null;
};

// Можно не заморачиваться с точным типом
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

type AvenorApi = {
  // очереди задач
  addJob(p: any): Promise<string>;
  addCompressJob(p: any): Promise<string>;
  addConvertJob(p: any): Promise<string>;

  // файловые диалоги
  pickFolder(): Promise<string | null>;
  pickDownloadDir(): Promise<string | null>;

  // управление задачами
  cancelJob(id: string): Promise<boolean>;
  removeJob(id: string): Promise<boolean>;

  // файловая система
  revealInFolder(filePath: string): Promise<boolean>;

  // SETTINGS
  getSettings(): Promise<any>;
  setSettings(partial: any): Promise<any>;

  // APP
  getVersion(): Promise<string>;
  getAssetUrl(rel: string): Promise<string>;
  checkUpdates(): Promise<any>;
  openExternal(url: string): Promise<boolean | void>;

  // HISTORY
  getHistory(): Promise<any[]>;
  historyRemove(id: string): Promise<void>;
  clearHistory(
    scope?: "all" | "download" | "compress" | "convert"
  ): Promise<{ ok?: boolean } | void>;

  // LICENSE
  getLicense(): Promise<RendererLicense>;
  setLicense(partial: Partial<RendererLicense>): Promise<RendererLicense>;

  // прогресс задач
  onProgress(cb: (p: JobProgress) => void): () => void;
};

declare global {
  interface Window {
    Avenor: any & {
      getLicense?: () => Promise<RendererLicense>;
      setLicense?: (
        partial: Partial<RendererLicense>
      ) => Promise<RendererLicense>;
      openExternal?: (url: string) => Promise<boolean | void>;

      checkUpdates?: () => Promise<{
        status: "no-update" | "checking" | "available" | "downloaded" | "error";
        version?: string;
        error?: string;
      }>;

      installUpdate?: () => Promise<void>;
    };

    AvenorWindow?: {
      minimize(): void;
      toggleMaximize(): void;
      close(): void;
      getState(): Promise<{ isMaximized: boolean }>;
      onState?(cb: (s: { isMaximized: boolean }) => void): () => void;
    };
  }
}

