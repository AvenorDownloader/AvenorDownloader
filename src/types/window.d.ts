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

declare global {
  interface Window {
    Avenor: any & {
      getLicense?: () => Promise<RendererLicense>;
      setLicense?: (
        partial: Partial<RendererLicense>
      ) => Promise<RendererLicense>;
      openExternal?: (url: string) => Promise<boolean | void>;
    };

    // делаем опциональным (мы в коде используем window.AvenorWindow?.)
    AvenorWindow?: {
      minimize(): void;
      toggleMaximize(): void;
      close(): void;
      getState(): Promise<{ isMaximized: boolean }>;
      onState?(cb: (s: { isMaximized: boolean }) => void): () => void;
    };
  }
}
