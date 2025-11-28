import { spawn, type ChildProcess } from "child_process";

import path from "path";
import fs from "fs";
import os from "os";
import { promisify } from "util";

import { CompressPayload, CompressProgress } from "./types/compress";
import { JobProgress } from "./types";

const stat = promisify(fs.stat);

// ----- utils -----
function uid() {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  );
}

function resolveBin(name: "ffmpeg.exe" | "ffprobe.exe" | "ffmpeg" | "ffprobe") {
  const isWin = process.platform === "win32";
  const fname = isWin
    ? name.endsWith(".exe")
      ? name
      : name + ".exe"
    : name.replace(".exe", "");
  const dev = path.join(process.cwd(), "resources", "bin", fname);
  const prod = path.join(process.resourcesPath || process.cwd(), "bin", fname);
  return fs.existsSync(dev) ? dev : prod;
}
const FFMPEG = resolveBin("ffmpeg.exe");
const FFPROBE = resolveBin("ffprobe.exe");

function pathToFileUrl(p: string) {
  let u = p.replace(/\\/g, "/");
  if (!u.startsWith("/")) u = "/" + u;
  return "file://" + u;
}

async function getDurationSec(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(
      FFPROBE,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file,
      ],
      { windowsHide: true }
    );
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.on("close", () => {
      const val = parseFloat(out);
      resolve(isFinite(val) ? val : null);
    });
    p.on("error", () => resolve(null));
  });
}

async function getFileSizeMB(file: string): Promise<number> {
  const s = await stat(file);
  return s.size / (1024 * 1024);
}

function makeVideoThumb(inputPath: string) {
  return new Promise<string>((resolve) => {
    // кладём превью в системный TEMP, чтобы не засорять папку с видео
    const safeName = path.parse(inputPath).name.replace(/[^\w.-]+/g, "_");
    const thumbPath = path.join(os.tmpdir(), `${safeName}.thumb.jpg`);

    const args = [
      "-ss",
      "1",
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=320:-1",
      "-y",
      thumbPath,
    ];
    const p = spawn(FFMPEG, args, { windowsHide: true });
    p.on("close", () => resolve(thumbPath));
    p.on("error", () => resolve(thumbPath));
  });
}


// ----- queue -----
type Cfg = { concurrency?: number };

export class CompressQueue {
  private pending: Array<{ id: string; payload: CompressPayload }> = [];
  private running = 0;
  private readonly max: number;
  private onProgress: (p: JobProgress) => void;

  // ▼ новое: трекаем процессы и отмены
  private jobCtx = new Map<string, ChildProcess[]>();
  private canceled = new Set<string>();

  constructor(onProgress: (p: JobProgress) => void, cfg?: Cfg) {
    this.onProgress = onProgress;
    this.max = Math.max(1, cfg?.concurrency ?? 1);
  }

  add(payload: CompressPayload) {
    const id = uid();
    this.pending.push({ id, payload });
    this.tick();
    return id;
  }

  cancel(id: string): boolean {
    const procs = this.jobCtx.get(id);
    this.canceled.add(id);

    // уведомим UI сразу
    this.send({ id, stage: "canceled", percent: 0 });

    if (!procs || !procs.length) return false;

    try {
      for (const cp of procs) {
        if (!cp || cp.killed) continue;

        if (process.platform === "win32") {
          // убиваем всё дерево процессов по PID
          try {
            spawn("taskkill", ["/PID", String(cp.pid), "/T", "/F"], {
              windowsHide: true,
            });
          } catch {}
        } else {
          try {
            cp.kill("SIGKILL");
          } catch {}
        }
      }
      return true;
    } catch (e) {
      console.error("[compress] cancel failed:", e);
      return false;
    }
  }

  private tick() {
    while (this.running < this.max && this.pending.length) {
      const job = this.pending.shift()!;
      this.runJob(job.id, job.payload);
    }
  }

  private send(p: Partial<CompressProgress> & { id: string }) {
    const cast: JobProgress = {
      id: p.id,
      stage: (p.stage as any) ?? "preparing",
      percent: p.percent,
      filepath: p.filepath,
      message: (p as any).message,
      source: "compress" as any, // важно для списка/истории
      meta: {
        ...(p.meta || {}),
        jobType: "compress",
      } as any,
    };
    this.onProgress(cast);
  }

  private async runJob(id: string, payload: CompressPayload) {
    this.running++;
    this.canceled.delete(id);
    this.jobCtx.set(id, []);

    const track = (cp: ChildProcess) => {
      const list = this.jobCtx.get(id);
      if (list) list.push(cp);
    };
    const isCanceled = () => this.canceled.has(id);

    try {
      this.send({ id, stage: "preparing", percent: 0 });

      const {
        inputPath,
        outDir,
        mode,
        targetMB,
        targetPercent,
        imageFormat = "jpeg",
        audioBitrateK = 160,
      } = payload;

      const ext = (path.extname(inputPath).replace(".", "") || "")
        .toLowerCase()
        .trim();
      const dir = outDir || path.dirname(inputPath);
      const base = path.basename(inputPath, path.extname(inputPath));

      // тип файла
      const isImage = [
        "jpg",
        "jpeg",
        "png",
        "bmp",
        "tiff",
        "gif",
        "webp",
        "heic",
        "heif",
      ].includes(ext);
      const isAudio = [
        "mp3",
        "wav",
        "aac",
        "m4a",
        "flac",
        "ogg",
        "opus",
      ].includes(ext);
      const isVideo = !isImage && !isAudio;

      // целевой размер
      const inSizeMB = await getFileSizeMB(inputPath);
      const targetSizeMB =
        mode === "percent"
          ? Math.max(1, Math.round(inSizeMB * (targetPercent! / 100)))
          : targetMB!;

      // имена
      const outExt = isImage
        ? imageFormat === "webp"
          ? "webp"
          : "jpg"
        : "mp4";
      const outPath = path.join(
        dir,
        `${base} (compressed-${targetSizeMB}MB).${outExt}`
      );
      const outName = path.basename(outPath);

      // превью
      let thumbnailUrl: string | undefined;
      if (isImage) {
        thumbnailUrl = pathToFileUrl(inputPath);
      } else if (isVideo) {
        // делаем превью в TEMP, а не рядом с видео
        makeVideoThumb(inputPath).then((t) => {
          this.send({
            id,
            stage: "probe",
            percent: 0,
            meta: { title: outName, thumbnail: pathToFileUrl(t) },
          });
        });
      }
      this.send({
        id,
        stage: "probe",
        percent: 0,
        meta: { title: outName, thumbnail: thumbnailUrl },
      });

      if (isCanceled()) {
        this.send({ id, stage: "canceled", percent: 0 });
        return;
      }

      // ----- изображения -----
      if (isImage) {
        this.send({
          id,
          stage: "compressing",
          percent: 0,
          meta: { isImage, title: outName },
        });

        let q = imageFormat === "webp" ? 80 : 85; // 0..100
        const workPath = outPath;

        for (let attempt = 1; attempt <= 5; attempt++) {
          await new Promise<void>((resolve, reject) => {
            const args = ["-y", "-i", inputPath];
            if (imageFormat === "webp") {
              args.push("-c:v", "libwebp", "-q:v", String(q));
            } else {
              args.push(
                "-c:v",
                "mjpeg",
                "-q:v",
                String(Math.max(2, Math.round((100 - q) / 2)))
              );
            }
            args.push(workPath);
            const pr = spawn(FFMPEG, args, { windowsHide: true });
            track(pr);
            pr.on("close", () => resolve());
            pr.on("error", reject);
          });

          if (isCanceled()) {
            this.send({ id, stage: "canceled", percent: 0 });
            return;
          }

          const size = await getFileSizeMB(workPath);
          const diff = Math.abs(size - targetSizeMB) / targetSizeMB;
          this.send({
            id,
            stage: "compressing",
            percent: Math.min(95, 20 + attempt * 15),
            meta: { title: outName },
          });
          if (diff < 0.08) break;

          if (size > targetSizeMB) q -= 10;
          else q += 7;
          q = Math.max(10, Math.min(95, q));
        }

        if (isCanceled()) {
          this.send({ id, stage: "canceled", percent: 0 });
          return;
        }

        const finalMB = await getFileSizeMB(outPath);
        this.send({
          id,
          stage: "done",
          percent: 100,
          filepath: outPath,
          meta: {
            isImage,
            sizeMB: finalMB,
            ext: outExt,
            title: outName,
            thumbnail: pathToFileUrl(outPath),
          },
        });
        return;
      }

      // ----- аудио/видео -----
      const dur = await getDurationSec(inputPath);
      if (!dur || !isFinite(dur) || dur <= 0) {
        this.send({
          id,
          stage: "error",
          message: "Не удалось определить длительность файла",
          meta: { title: outName },
        });
        return;
      }

      if (isCanceled()) {
        this.send({ id, stage: "canceled", percent: 0 });
        return;
      }

      // общий целевой битрейт (кбит/с)
      let targetTotalKbps = Math.max(
        200,
        Math.floor((targetSizeMB * 1024 * 1024 * 8) / dur / 1000)
      );

      if (isAudio) {
        const ab = Math.max(64, Math.min(320, targetTotalKbps));
        this.send({
          id,
          stage: "encoding",
          percent: 5,
          meta: { isAudio, durationSec: dur, title: outName },
        });

        await runFFmpegTwoPassAudio(inputPath, outPath, ab, track);

        if (isCanceled()) {
          this.send({ id, stage: "canceled", percent: 0 });
          return;
        }

        const finalMB = await getFileSizeMB(outPath);
        this.send({
          id,
          stage: "done",
          percent: 100,
          filepath: outPath,
          meta: {
            isAudio,
            durationSec: dur,
            ext: "mp4",
            sizeMB: finalMB,
            title: outName,
          },
        });
        return;
      }

      // видео
      const audioK = Math.min(audioBitrateK, targetTotalKbps - 64);
      const videoK = Math.max(200, targetTotalKbps - audioK);

      this.send({
        id,
        stage: "pass1",
        percent: 5,
        meta: { isVideo, durationSec: dur, title: outName },
      });

      await runFFmpegTwoPassVideo(
        inputPath,
        outPath,
        videoK,
        audioK,
        dur,
        (p) => {
          this.send({
            id,
            stage: "pass2",
            percent: p,
            meta: { isVideo, durationSec: dur, title: outName },
          });
        },
        track
      );

      if (isCanceled()) {
        this.send({ id, stage: "canceled", percent: 0 });
        return;
      }

      const finalMB = await getFileSizeMB(outPath);
      this.send({
        id,
        stage: "done",
        percent: 100,
        filepath: outPath,
        meta: {
          isVideo,
          durationSec: dur,
          ext: "mp4",
          sizeMB: finalMB,
          title: outName,
          thumbnail: thumbnailUrl,
        },
      });
    } catch (e: any) {
      if (this.canceled.has(id)) {
        // уже отменено — просто не шумим ошибками
        this.send({ id, stage: "canceled", percent: 0 });
      } else {
        this.send({
          id,
          stage: "error",
          message: String(e?.message || e),
        });
      }
    } finally {
      this.running--;
      this.jobCtx.delete(id);
      this.canceled.delete(id);
      this.tick();
    }
  }
}

type TrackFn = (cp: ChildProcess) => void;

function runFFmpegTwoPassVideo(
  input: string,
  outPath: string,
  vKbps: number,
  aKbps: number,
  durationSec: number,
  onProgress: (percent: number) => void,
  track?: TrackFn
) {
  return new Promise<void>((resolve, reject) => {
    const log = path.join(os.tmpdir(), "avenor-ffmpeg-passlog");

    const pass1 = spawn(
      FFMPEG,
      [
        "-y",
        "-i",
        input,
        "-c:v",
        "libx264",
        "-b:v",
        `${vKbps}k`,
        "-pass",
        "1",
        "-passlogfile",
        log,
        "-an",
        "-f",
        "mp4",
        process.platform === "win32" ? "NUL" : "/dev/null",
      ],
      { windowsHide: true }
    );
    track?.(pass1);

    pass1.on("close", () => {
      const pass2 = spawn(
        FFMPEG,
        [
          "-y",
          "-i",
          input,
          "-c:v",
          "libx264",
          "-b:v",
          `${vKbps}k`,
          "-pass",
          "2",
          "-passlogfile",
          log,
          "-c:a",
          "aac",
          "-b:a",
          `${aKbps}k`,
          outPath,
        ],
        { windowsHide: true }
      );
      track?.(pass2);

      pass2.stderr.on("data", (d) => {
        const s = String(d);
        const m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          const h = parseInt(m[1], 10);
          const mn = parseInt(m[2], 10);
          const sec = parseFloat(m[3]);
          const cur = h * 3600 + mn * 60 + sec;
          const p = Math.max(0, Math.min(99, (cur / durationSec) * 100));
          onProgress(p);
        }
      });

      pass2.on("close", () => resolve());
      pass2.on("error", reject);
    });

    pass1.on("error", reject);
  });
}

function runFFmpegTwoPassAudio(
  input: string,
  outPath: string,
  aKbps: number,
  track?: TrackFn
) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(
      FFMPEG,
      ["-y", "-i", input, "-vn", "-c:a", "aac", "-b:a", `${aKbps}k`, outPath],
      { windowsHide: true }
    );
    track?.(p);
    p.on("close", () => resolve());
    p.on("error", reject);
  });
}

