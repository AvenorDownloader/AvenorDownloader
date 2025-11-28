// ===== src/queue.ts =====
import { spawn as spSpawn } from "child_process";
import path from "path";
import fs from "fs";
import { app } from "electron";
import { AddJobPayload, JobProgress } from "./types";
import type { ChildProcess } from "child_process";

// ---------- утилиты ----------
function uid() {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  );
}

function resolveBin(name: "yt-dlp.exe" | "ffmpeg.exe" | "ffprobe.exe") {
  const devPath = path.join(process.cwd(), "resources", "bin", name);
  const prodPath = path.join(process.resourcesPath, "bin", name);
  return fs.existsSync(devPath) ? devPath : prodPath;
}

const YTDLP = resolveBin("yt-dlp.exe");
const FFMPEG = resolveBin("ffmpeg.exe");

// Нормализатор имени файла (Unicode сохраняем!)
function sanitizeFilename(name: string) {
  // Нормализуем юникод и приводим «проблемные» символы
  let n = name
    .normalize("NFC")
    .replace(/\uFFFD/g, "") // убираем символ-заглушку �
    .replace(/\u00A0/g, " ") // NBSP → обычный пробел
    .replace(/[\u2018\u2019\u2032]/g, "'") // ‘ ’ ′ → '
    .replace(/[\u201C\u201D\u2033]/g, '"') // “ ” ″ → "
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ") // запретные для Windows
    .replace(/\s+/g, " ")
    .trim();

  // Мягкая деградация экзотики до "_", если вдруг что-то редкое осталось
  n = n.replace(/[^\p{L}\p{N}\s\-_.()[\]]/gu, "_");

  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  return reserved.test(n) ? `_${n}` : n;
}


// Хелпер конвертации единиц в MB
function toMB(val: number, unit: string) {
  const u = unit.toUpperCase();
  if (u === "KIB") return val / 1024;
  if (u === "MIB") return val;
  if (u === "GIB") return val * 1024;
  if (u === "TIB") return val * 1024 * 1024;
  if (u === "KB") return val / 1024;
  if (u === "MB") return val;
  if (u === "GB") return val * 1024;
  if (u === "TB") return val * 1024 * 1024;
  return val;
}

// Лёгкая проба метаданных (title/id/форматы), чтобы собрать имя
async function probeMeta(url: string) {
  return new Promise<
    | {
        ext?: string;
        vcodec?: string;
        acodec?: string;
        resolution?: string;
        fps?: number;
        title?: string;
        id?: string;
        durationSec?: number;
        thumbnail?: string;
      }
    | undefined
  >((resolve) => {
    const p = spSpawn(YTDLP, ["-j", "--no-warnings", "--no-playlist", url], {
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
    });
    let json = "";
    p.stdout.on("data", (d: Buffer) => (json += d.toString()));
    p.on("close", () => {
      try {
        const o = JSON.parse(json);
        // пытаемся взять лучший thumbnail
        const thumb =
          (Array.isArray(o.thumbnails) && o.thumbnails.length
            ? o.thumbnails[o.thumbnails.length - 1]?.url || o.thumbnails[0]?.url
            : undefined) || o.thumbnail;

        resolve({
          ext: o.ext,
          vcodec: o.vcodec,
          acodec: o.acodec,
          resolution: o.resolution || (o.height ? `${o.height}p` : undefined),
          fps: o.fps,
          title: o.title,
          id: o.id,
          durationSec: typeof o.duration === "number" ? o.duration : undefined,
          thumbnail: thumb, // ← добавили
        });
      } catch {
        resolve(undefined);
      }
    });
  });
}

// Формат-строка
function buildFormat(p: AddJobPayload) {
  // Предпочтение H.264 (avc1) в MP4, иначе любой НЕ av01 в MP4, и в самом конце — любой MP4.
  const h264Cap = (h: number) =>
    "bv*[height<=" +
    h +
    "][vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a]/" +
    "bv*[height<=" +
    h +
    "][vcodec!^=av01][ext=mp4]+ba/" +
    "b[height<=" +
    h +
    "][ext=mp4]";

  switch (p.quality) {
    case "8k":
      return "bestvideo[height>=4320]+bestaudio/best";
    case "4k":
      return "bestvideo[height>=2160]+bestaudio/best";
    case "2k":
      return "bestvideo[height>=1440]+bestaudio/best";

    case "1080p":
      return h264Cap(1080);
    case "720p":
      return h264Cap(720);
    case "480p":
      return h264Cap(480);
    case "360p":
      return h264Cap(360);
    case "240p":
      return h264Cap(240);

    // «Лучшее»: чтобы ролики с макс. разрешением ≤1080 тоже приходили в H.264,
    // сразу даём H.264-ветку до 1080, а если ролик выше — сработают верхние кейсы при выборе качества.
    case "best":
    default:
      // без ограничения высоты — берем максимум доступного качества
      return "bestvideo+bestaudio/best";
  }
}



// Внутренний эмиттер без id (id добавляем в add())
type EmitCore = (p: Omit<JobProgress, "id">) => void;

// ---------- очередь ----------
export class DownloadQueue {
  private emit: (p: JobProgress) => void;
  private running = 0;
  private jobCtx = new Map<
    string,
    { child: ChildProcess; plannedPath: string; outDir: string }
  >();
  private canceled = new Set<string>();
  constructor(emit: (p: JobProgress) => void) {
    this.emit = emit;
  }
  cancel(id: string): boolean {
    const ctx = this.jobCtx.get(id);
    if (!ctx) return false;
    
    try {
      this.canceled.add(id);

      // 1) UI: сразу сказать карточке, что отменили (моментально)
      this.emit({ id, stage: "canceled" } as any);

      // 2) Жёстко гасим всё дерево процессов (особенно важно на Windows)
      if (process.platform === "win32") {
        // убиваем родителя и всех детей (ffmpeg и т.д.)
        spSpawn("taskkill", ["/PID", String(ctx.child.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else {
        // Linux/macOS — жёсткий килл
        try {
          ctx.child.kill("SIGKILL");
        } catch {}
      }

      // 3) На всякий случай подчистим файлы (частичные/финальные)
      this.cleanupCanceledFiles(ctx.plannedPath, ctx.outDir);

      return true;
    } catch (e) {
      console.error("[queue] cancel() failed:", e);
      return false;
    }
  }

  private cleanupCanceledFiles(plannedPath: string, outDir: string) {
    try {
      const baseName = path.basename(plannedPath);
      const baseNoExt = baseName.replace(/\.[^.]+$/, "");

      // кандидаты на удаление: финальный файл и все временные рядом
      const entries = fs.readdirSync(outDir);
      for (const name of entries) {
        if (!name.startsWith(baseNoExt)) continue;

        // .part / .ytdl / .frag / .temp и т.п., а также сам финальный файл
        const isTemp =
          /\.(part|ytdl|temp|fragment|frag|meta|info\.json|webm\.part|m4a\.part)$/i.test(
            name
          );
        const isFinal = name === baseName;

        if (isTemp || isFinal) {
          try {
            fs.unlinkSync(path.join(outDir, name));
          } catch {}
        }
      }
    } catch {}
  }

  // «Удалить» — сейчас просто отмена, а UI карточку удаляет сам
  remove(_id: string): boolean {
    // при желании тут можно чистить историю/файлы
    return true;
  }

  add(payload: AddJobPayload, onStart?: () => void) {
    const id = uid();
    this.run(id, payload, (p) => this.emit({ id, ...p }));
    onStart?.();
    return id;
  }

  // Скачивание
  private async run(id: string, payload: AddJobPayload, emit: EmitCore) {
    this.running++;

    const outDir =
      payload.outDir ||
      path.join(app.getPath("downloads"), "Avenor", "Downloads");
    fs.mkdirSync(outDir, { recursive: true });

    // 1) Метаданные ДО сборки имени
    const meta = await probeMeta(payload.url);

    // 2) Формируем читаемое имя и финальный путь (Unicode OK)
    const finalExt = payload.type === "audio" ? "m4a" : "mp4";
    const safeTitle = sanitizeFilename(
      meta?.title || (payload.type === "audio" ? "audio" : "video")
    );
    const resTag = meta?.resolution ? ` [${meta.resolution}]` : "";
    const idTag = meta?.id ? ` (${meta.id})` : "";
    const plannedPath = path.join(
      outDir,
      `${safeTitle}${resTag}${idTag}.${finalExt}`
    );

    // 3) Аргументы yt-dlp
    const args: string[] = [
      "-N",
      "16",
      "--ffmpeg-location",
      FFMPEG,
      "--no-playlist",
      "--no-warnings",

      // КРИТИЧНО: форсим прогресс в non-TTY
      "--progress",
      "--newline",
      "--no-color",
      "--force-overwrites",
      "--no-continue", // не продолжать докачку после прерывания
      "--no-keep-fragments", // не хранить фрагменты после обработки

      "-o",
      plannedPath,
      "--merge-output-format",
      "mp4",
      "--remux-video",
      "mp4",

      // наш детерминированный прогресс
      "--progress-template",
      // _percent_str даёт " 12.3%", бывает с пробелом; чистим потом
      "[AVENOR] %(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress._speed_str)s|%(progress._eta_str)s",
    ];

    if (payload.type === "audio") {
      args.push("-x", "--audio-format", "m4a");
    } else {
      let fmt: string;
      if (payload.quality === "best") {
        const h = parseHeight(meta?.resolution);
        // для роликов с макс. разрешением ≤1080 — отдаём H.264-ветку
        if (h && h <= 1080) {
          // тот же приоритет H.264, что и в buildFormat для 1080p
          fmt =
            "bv*[height<=1080][vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a]/" +
            "bv*[height<=1080][vcodec!^=av01][ext=mp4]+ba/" +
            "b[height<=1080][ext=mp4]";
        } else {
          // для 2K/4K/8K — берём максимум (может быть AV1/VP9/HEVC)
          fmt = "bestvideo+bestaudio/best";
        }
      } else {
        // для явно выбранных качеств используем прежнюю логику
        fmt = buildFormat(payload);
      }

      args.push("-f", fmt);
    }

    // --- Условная перекодировка для совместимости с Premiere на ≤1080p ---
    function parseHeight(res?: string): number | undefined {
      if (!res) return;
      if (/^\d+x\d+$/i.test(res)) return parseInt(res.split("x")[1], 10);
      if (/^\d+p$/i.test(res)) return parseInt(res, 10);
    }

    if (payload.type !== "audio") {
      const h = parseHeight(meta?.resolution);
      const vc = meta?.vcodec?.toLowerCase() || "";

      // если высота ≤1080 и кодек не H.264 — перекодируем в H.264 (libx264)
      if (h && h <= 1080 && !vc.startsWith("avc1") && !vc.startsWith("h264")) {
        args.push(
          "--recode-video",
          "mp4",
          "--postprocessor-args",
          // VideoEncode -> опции для ffmpeg: быстрый пресет, yuv420p, +faststart
          "VideoEncode:-vcodec libx264 -pix_fmt yuv420p -preset veryfast -movflags +faststart"
        );
      }
    }

    emit({
      source: "download",
      stage: "preparing",
      meta: meta
        ? {
            title: meta.title,
            ext: meta.ext,
            vcodec: meta.vcodec,
            acodec: meta.acodec,
            resolution: meta.resolution,
            fps: meta.fps,
            durationSec: meta.durationSec,
            thumbnail: (meta as any).thumbnail,
            date: new Date().toISOString(),
          }
        : undefined,
    });

    const child = spSpawn(YTDLP, [...args, payload.url], {
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
    });

    this.jobCtx.set(id, { child, plannedPath, outDir });
    // общий обработчик и для stdout, и для stderr
    function makeLineReader(onLine: (line: string) => void) {
      let buf = "";
      return (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        // разбиваем по \n, \r\n и даже одиночным \r
        const parts = buf.split(/\r?\n|\r/g);
        buf = parts.pop() ?? ""; // хвост оставляем
        for (const raw of parts) {
          const line = raw.replace(/\x1b\[[0-9;]*m/g, ""); // убираем ANSI
          onLine(line);
        }
      };
    }

    const onLine = (lineRaw: string) => {
      const lineClean = lineRaw.trim();
      // если уже отменили — игнорим дальнейший парсинг прогресса
      if (this.canceled.has(id)) return;

      // 1) наш контролируемый прогресс
      if (lineClean.startsWith("[AVENOR] ")) {
        const prog = lineClean.slice(10);
        const [percentStr, downBytesStr, totalBytesStr, speedStr, etaStr] =
          prog.split("|");

        const percent = Number(
          (percentStr || "").replace("%", "").replace(",", ".").trim()
        );

        const downloadedMB = downBytesStr
          ? parseFloat(downBytesStr) / (1024 * 1024)
          : undefined;
        const totalMB = totalBytesStr
          ? parseFloat(totalBytesStr) / (1024 * 1024)
          : undefined;
        const speed = speedStr && speedStr !== "N/A" ? speedStr : undefined;
        const eta = etaStr && etaStr !== "N/A" ? etaStr : undefined;

        emit({
          source: "download",
          stage: "downloading",
          ...(Number.isFinite(percent) ? { percent } : {}),
          ...(typeof downloadedMB === "number" && Number.isFinite(downloadedMB)
            ? { downloadedMB }
            : {}),
          ...(typeof totalMB === "number" && Number.isFinite(totalMB)
            ? { totalMB }
            : {}),
          ...(speed ? { speed } : {}),
          ...(eta ? { eta } : {}),
        });

        return;
      }

      // 2) fallback: стандартный вывод yt-dlp
      const pctMatch = lineClean.match(/\[download\][^\n]*?(\d+(?:\.\d+)?)%/i);
      if (pctMatch) {
        const percent = parseFloat(pctMatch[1]);

        let total: number | undefined;
        let downloaded: number | undefined;

        const mA = lineClean.match(
          /\bof\s+([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)\b/i
        );
        if (mA) total = toMB(parseFloat(mA[1]), mA[2]);

        const mB =
          !mA &&
          lineClean.match(
            /([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)\s*\/\s*([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)/i
          );
        if (mB) {
          downloaded = toMB(parseFloat(mB[1]), mB[2]);
          total = toMB(parseFloat(mB[3]), mB[4]);
        }

        const speed = (lineClean.match(
          /([0-9.]+(?:KiB|MiB|GiB|KB|MB|GB|TB)\/s)/i
        ) || [])[1];
        const eta = (lineClean.match(
          /\b(?:ETA\s+)?(\d{1,2}:\d{2}(?::\d{2})?)\b/i
        ) || [])[1];

        console.log("[Q]", "downloading", percent);

        emit({
          source: "download",
          stage: "downloading",
          percent,
          ...(typeof downloaded === "number"
            ? { downloadedMB: downloaded }
            : {}),
          ...(typeof total === "number" ? { totalMB: total } : {}),
          ...(speed ? { speed } : {}),
          ...(eta ? { eta } : {}),
        });
        return;
      }

      // 4) слияние
      if (
        /\[(?:Merger|ffmpeg)\]\s+(?:Merging|Muxing)\b/i.test(lineClean) ||
        /\b(?:Merger|Merging formats|Merging output|Muxing|Converting)\b/i.test(
          lineClean
        )
      ) {
        emit({ source: "download", stage: "merging" });
        return;
      }

      // 5) уже скачано
      const already = lineClean.match(
        /\[download\]\s+(.*)\s+has already been downloaded/i
      );
      if (already) {
        emit({ source: "download", stage: "done", filepath: plannedPath }); // всегда наш детерминированный путь
        return;
      }

      // 6) ошибка
      if (/ERROR/i.test(lineClean)) {
        emit({ source: "download", stage: "error", message: lineClean });
        return;
      }
    };

    child.stdout.on("data", makeLineReader(onLine));
    child.stderr.on("data", makeLineReader(onLine));

    child.on("close", (code: number | null) => {
      const wasCanceled = this.canceled.has(id);

      // контексты чистим в любом случае
      this.jobCtx.delete(id);
      this.canceled.delete(id);

      if (wasCanceled) {
        // Уже отправили "canceled" из cancel(), но на всякий случай подчистим хвосты
        this.cleanupCanceledFiles(plannedPath, outDir);
        // НИЧЕГО НЕ ЭМИТИМ здесь повторно, чтобы не мигало в UI
      } else if (code === 0) {
        let sizeMB: number | undefined;
        try {
          const st = fs.statSync(plannedPath);
          sizeMB = st.size / (1024 * 1024);
        } catch {}
        emit({
          source: "download",
          stage: "done",
          filepath: plannedPath,
          meta: {
            title: meta?.title,
            ext: path.extname(plannedPath).replace(/^\./, "") || meta?.ext,
            resolution: meta?.resolution,
            fps: meta?.fps,
            durationSec: meta?.durationSec,
            sizeMB,
            thumbnail: (meta as any)?.thumbnail,
            date: new Date().toISOString(),
          },
        });
      } else {
        emit({
          source: "download",
          stage: "error",
          message: `yt-dlp exited with code ${code}`,
        });
      }

      this.running--;
    });
  }
}


