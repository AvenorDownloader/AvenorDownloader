import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { promisify } from "util";
import { JobProgress } from "./types";

const stat = promisify(fs.stat);

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
      const v = parseFloat(out);
      resolve(isFinite(v) ? v : null);
    });
    p.on("error", () => resolve(null));
  });
}
async function getFileSizeMB(file: string): Promise<number> {
  const s = await stat(file);
  return s.size / (1024 * 1024);
}
function extOf(p: string) {
  return (path.extname(p).replace(".", "") || "").toLowerCase().trim();
}
function isImageExt(e: string) {
  return [
    "jpg",
    "jpeg",
    "png",
    "bmp",
    "tiff",
    "tif",
    "gif",
    "webp",
    "heic",
    "heif",
  ].includes(e);
}
function isAudioExt(e: string) {
  return ["mp3", "wav", "aac", "m4a", "flac", "ogg", "opus"].includes(e);
}

type ConvertPayload = {
  inputPath: string;
  outDir?: string;
  targetExt: string; // во что конвертировать (mp4/mp3/jpg/...)
  videoCrf?: number; // для видео
  audioKbps?: number; // для видео/аудио
  imageQuality?: number; // для изображений (0..100)
};

type Cfg = { concurrency?: number };

export class ConvertQueue {
  private pending: Array<{ id: string; payload: ConvertPayload }> = [];
  private running = 0;
  private readonly max: number;
  private onProgress: (p: JobProgress) => void;

  constructor(onProgress: (p: JobProgress) => void, cfg?: Cfg) {
    this.onProgress = onProgress;
    this.max = Math.max(1, cfg?.concurrency ?? 2);
  }

  add(payload: ConvertPayload) {
    const id = uid();
    this.pending.push({ id, payload });
    this.tick();
    return id;
  }

  private tick() {
    while (this.running < this.max && this.pending.length) {
      const job = this.pending.shift()!;
      this.run(job.id, job.payload);
    }
  }

  private send(p: {
    id: string;
    stage?: any;
    percent?: number;
    filepath?: string;
    message?: string;
    meta?: any;
  }) {
    const cast: JobProgress = {
      id: p.id,
      stage: (p.stage as any) ?? "preparing",
      percent: p.percent,
      filepath: p.filepath,
      message: p.message,
      meta: { ...(p.meta || {}), jobType: "convert" } as any,
    } as any;

    // ВАЖНО: явно помечаем источник как "convert"
    (cast as any).source = "convert";

    this.onProgress(cast);
  }

  private async run(id: string, payload: ConvertPayload) {
    this.running++;
    try {
      const { inputPath, outDir, targetExt } = payload;
      const eIn = extOf(inputPath);
      const dir = outDir || path.dirname(inputPath);
      const base = path.basename(inputPath, path.extname(inputPath));
      const outPath = path.join(dir, `${base}.${targetExt.toLowerCase()}`);
      const outName = path.basename(outPath);

      this.send({
        id,
        stage: "preparing",
        percent: 0,
        meta: { title: outName },
      });

      const inIsImage = isImageExt(eIn);
      const inIsAudio = isAudioExt(eIn);
      const inIsVideo = !inIsImage && !inIsAudio;
      const outIsAudio = isAudioExt(targetExt);

      // превью:
      //  - для изображений — просто ссылка на сам файл
      //  - для видео — только если ВЫХОД не аудио (чтобы при mp3 не плодить jpg)
      if (inIsImage) {
        this.send({
          id,
          stage: "preparing",
          meta: { title: outName, thumbnail: pathToFileUrl(inputPath) },
        });
      } else if (inIsVideo && !outIsAudio) {
        const thumb = path.join(os.tmpdir(), `avenor-thumb-${uid()}.jpg`);
        await new Promise<void>((resolve) => {
          const p = spawn(
            FFMPEG,
            [
              "-y",
              "-ss",
              "1",
              "-i",
              inputPath,
              "-frames:v",
              "1",
              "-vf",
              "scale=320:-1",
              thumb,
            ],
            { windowsHide: true }
          );
          p.on("close", () => {
            this.send({
              id,
              stage: "preparing",
              meta: { title: outName, thumbnail: pathToFileUrl(thumb) },
            });
            resolve();
          });
          p.on("error", () => resolve());
        });
      }

      // маршруты
      if (inIsImage) {
        await this.convertImage(id, payload, outPath, outName);
      } else if (inIsAudio && isAudioExt(targetExt)) {
        await this.convertAudio(id, payload, outPath, outName);
      } else if (
        (inIsVideo &&
          ["mp4", "mkv", "mov", "webm", "gif"].includes(targetExt)) ||
        (inIsAudio && ["mp4", "mkv", "mov", "webm", "gif"].includes(targetExt))
      ) {
        await this.convertVideo(id, payload, outPath, outName);
      } else if (inIsVideo && isAudioExt(targetExt)) {
        // вытащить аудио из видео
        await this.convertAudioFromVideo(id, payload, outPath, outName);
      } else {
        this.send({
          id,
          stage: "error",
          message: "Неподдерживаемая комбинация форматов",
          meta: { title: outName },
        });
      }
    } catch (e: any) {
      this.send({ id, stage: "error", message: String(e?.message || e) });
    } finally {
      this.running--;
      this.tick();
    }
  }

  // --- image -> image ---
  private async convertImage(
    id: string,
    payload: ConvertPayload,
    outPath: string,
    outName: string
  ) {
    const { inputPath, targetExt, imageQuality = 85 } = payload;
    const args = ["-y", "-i", inputPath];

    if (targetExt === "webp") {
      args.push(
        "-c:v",
        "libwebp",
        "-q:v",
        String(Math.max(1, Math.min(100, imageQuality)))
      );
    } else if (targetExt === "jpg" || targetExt === "jpeg") {
      // у mjpeg шкала обратная: меньше — лучше
      const q = Math.max(
        2,
        Math.round((100 - Math.max(1, Math.min(100, imageQuality))) / 2)
      );
      args.push("-c:v", "mjpeg", "-q:v", String(q));
    } else {
      // png/tiff/bmp — без доп. опций (по дефолту lossless)
    }
    args.push(outPath);

    await new Promise<void>((resolve, reject) => {
      const p = spawn(FFMPEG, args, { windowsHide: true });
      p.on("close", () => resolve());
      p.on("error", reject);
    });

    const sizeMB = await getFileSizeMB(outPath);
    this.send({
      id,
      stage: "done",
      percent: 100,
      filepath: outPath,
      meta: {
        title: outName,
        ext: targetExt,
        sizeMB,
        thumbnail: pathToFileUrl(outPath),
      },
    });
  }

  // --- audio -> audio OR extract from video ---
  private async convertAudio(
    id: string,
    payload: ConvertPayload,
    outPath: string,
    outName: string
  ) {
    const { inputPath, targetExt, audioKbps = 192 } = payload;
    const args = ["-y", "-i", inputPath, "-vn"];

    // кодек под расширение
    if (targetExt === "mp3")
      args.push("-c:a", "libmp3lame", "-b:a", `${audioKbps}k`);
    else if (targetExt === "aac" || targetExt === "m4a")
      args.push("-c:a", "aac", "-b:a", `${audioKbps}k`);
    else if (targetExt === "ogg") args.push("-c:a", "libvorbis", "-q:a", "5");
    else if (targetExt === "opus")
      args.push(
        "-c:a",
        "libopus",
        "-b:a",
        `${Math.max(64, Math.min(256, audioKbps))}k`
      );
    else if (targetExt === "flac") args.push("-c:a", "flac");
    else if (targetExt === "wav") args.push("-c:a", "pcm_s16le");
    else args.push("-c:a", "aac", "-b:a", `${audioKbps}k`);

    args.push(outPath);

    await new Promise<void>((resolve, reject) => {
      const p = spawn(FFMPEG, args, { windowsHide: true });
      p.on("close", () => resolve());
      p.on("error", reject);
    });

    const sizeMB = await getFileSizeMB(outPath);
    this.send({
      id,
      stage: "done",
      percent: 100,
      filepath: outPath,
      meta: { title: outName, ext: targetExt, sizeMB },
    });
  }
  private async convertAudioFromVideo(
    id: string,
    payload: ConvertPayload,
    outPath: string,
    outName: string
  ) {
    await this.convertAudio(id, payload, outPath, outName);
  }

  // --- video/audio -> video (контейнер и кодеки подбираем по расширению) ---
  private async convertVideo(
    id: string,
    payload: ConvertPayload,
    outPath: string,
    outName: string
  ) {
    const { inputPath, targetExt, videoCrf = 22, audioKbps = 192 } = payload;
    const dur = await getDurationSec(inputPath);

    const buildArgs = (): string[] => {
      if (targetExt === "webm") {
        return [
          "-y",
          "-i",
          inputPath,
          "-c:v",
          "libvpx-vp9",
          "-b:v",
          "0",
          "-crf",
          String(videoCrf),
          "-c:a",
          "libopus",
          "-b:a",
          `${audioKbps}k`,
          outPath,
        ];
      }
      if (targetExt === "gif") {
        return [
          "-y",
          "-i",
          inputPath,
          "-vf",
          "fps=12,scale=480:-1:flags=lanczos",
          "-loop",
          "0",
          outPath,
        ];
      }
      // mp4/mov/mkv — H.264 + AAC
      return [
        "-y",
        "-i",
        inputPath,
        "-c:v",
        "libx264",
        "-crf",
        String(videoCrf),
        "-preset",
        "medium",
        "-c:a",
        "aac",
        "-b:a",
        `${audioKbps}k`,
        outPath,
      ];
    };

    const args = buildArgs();

    await new Promise<void>((resolve, reject) => {
      const p = spawn(FFMPEG, args, { windowsHide: true });
      if (dur && isFinite(dur)) {
        p.stderr.on("data", (d) => {
          const s = String(d);
          const m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (m) {
            const h = parseInt(m[1], 10),
              mn = parseInt(m[2], 10),
              sec = parseFloat(m[3]);
            const cur = h * 3600 + mn * 60 + sec;
            const pct = Math.max(0, Math.min(99, (cur / dur) * 100));
            this.send({
              id,
              stage: "encoding",
              percent: pct,
              meta: { title: outName },
            });
          }
        });
      } else {
        this.send({
          id,
          stage: "encoding",
          percent: 10,
          meta: { title: outName },
        });
      }
      p.on("close", () => resolve());
      p.on("error", reject);
    });

    const sizeMB = await getFileSizeMB(outPath);
    this.send({
      id,
      stage: "done",
      percent: 100,
      filepath: outPath,
      meta: { title: outName, ext: targetExt, sizeMB },
    });
  }
}


