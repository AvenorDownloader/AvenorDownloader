export type QualityKey =
  | "best"
  | "8k"
  | "4k"
  | "2k"
  | "1080p"
  | "720p"
  | "480p"
  | "360p"
  | "240p";

export interface AddJobPayload {
  url: string;
  type: "video" | "audio";
  quality: QualityKey;
  outDir?: string;
}

export interface JobProgress {
  id: string;
  stage:
    | "preparing"
    | "downloading"
    | "merging"
    | "post"
    | "done"
    | "error"
    | "canceled";

  source?: "download" | "compress" | "convert";
  percent?: number; // 0..100
  downloadedMB?: number; // so far
  totalMB?: number; // size
  speed?: string; // e.g. 5.2 MiB/s
  eta?: string; // 00:42
  filepath?: string; // final path
  message?: string; // errors / notes
  meta?: {
    title?: string;
    ext?: string;
    vcodec?: string;
    acodec?: string;
    resolution?: string;
    fps?: number;
    durationSec?: number;
    sizeMB?: number;
    thumbnail?: string;
    date?: string; // ISO
  };
}
