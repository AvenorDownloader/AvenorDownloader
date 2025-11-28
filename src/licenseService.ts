// src/licenseService.ts
import { app, ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";

export type LicensePlanId = "free" | "pro_month" | "pro_year";

export type License = {
  plan: LicensePlanId;
  isPro: boolean;
  expiresAt: string | null; // ISO-строка или null
  lastCheckedAt?: string | null; // когда последний раз обновляли с сервера
};

const DEFAULT_LICENSE: License = {
  plan: "free",
  isPro: false,
  expiresAt: null,
  lastCheckedAt: null,
};

function getLicenseFilePath(): string {
  const userDir = app.getPath("userData");
  return path.join(userDir, "license.json");
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/**
 * Нормализуем лицензию:
 * – если истекла → free
 * – если нет даты истечения, но план не free → оставляем isPro как есть
 */
function normalizeLicense(input: Partial<License> | null | undefined): License {
  const merged: License = {
    ...DEFAULT_LICENSE,
    ...(input || {}),
  };

  const now = Date.now();

  if (merged.expiresAt) {
    const exp = new Date(merged.expiresAt);
    const ts = exp.getTime();
    if (!Number.isFinite(ts) || ts <= now) {
      // срок вышел или дата битая → сбрасываем
      merged.plan = "free";
      merged.isPro = false;
      merged.expiresAt = null;
    } else {
      // активная подписка
      merged.isPro = true;
      if (merged.plan === "free") {
        // на всякий случай, если с сервера пришёл free + дата
        merged.plan = "pro_month";
      }
    }
  } else {
    // нет даты истечения → считаем free
    merged.plan = "free";
    merged.isPro = false;
  }

  // по умолчанию — lastCheckedAt сейчас, если не задано
  if (!merged.lastCheckedAt) {
    merged.lastCheckedAt = new Date().toISOString();
  }

  return merged;
}

// === Публичные функции ===

export async function readLicenseFromDisk(): Promise<License> {
  const file = getLicenseFilePath();

  try {
    const raw = await fs.promises.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<License>;
    const normalized = normalizeLicense(parsed);

    // заодно перезапишем, если вдруг что-то поменялось (истекла и т.п.)
    const dir = path.dirname(file);
    ensureDir(dir);
    await fs.promises.writeFile(
      file,
      JSON.stringify(normalized, null, 2),
      "utf8"
    );

    return normalized;
  } catch {
    // файла нет или битый JSON → создаём дефолтную лицензию
    const normalized = normalizeLicense(DEFAULT_LICENSE);
    const dir = path.dirname(file);
    ensureDir(dir);
    await fs.promises.writeFile(
      file,
      JSON.stringify(normalized, null, 2),
      "utf8"
    );
    return normalized;
  }
}

export async function writeLicenseToDisk(
  partial: Partial<License>
): Promise<License> {
  let current: License;
  try {
    current = await readLicenseFromDisk();
  } catch {
    current = DEFAULT_LICENSE;
  }

  const merged = normalizeLicense({
    ...current,
    ...partial,
    // always update lastCheckedAt on write
    lastCheckedAt: new Date().toISOString(),
  });

  const file = getLicenseFilePath();
  const dir = path.dirname(file);
  ensureDir(dir);
  await fs.promises.writeFile(file, JSON.stringify(merged, null, 2), "utf8");

  return merged;
}

// Регистрируем IPC-обработчики, чтобы preload/renderer могли дергать лицензию
export function registerLicenseIpc() {
  ipcMain.handle("license:get", async () => {
    return await readLicenseFromDisk();
  });

  // пригодится для тестов / админки в будущем
  ipcMain.handle(
    "license:set",
    async (_event, partial: Partial<License> | null | undefined) => {
      return await writeLicenseToDisk(partial || {});
    }
  );
}
