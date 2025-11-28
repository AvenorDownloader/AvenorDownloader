// src/types/compress.ts

export type CompressMode = "size" | "percent";

/** Расширяем набор стадий, которые шлёт compressQueue */
export type CompressStage =
  | "preparing"
  | "probe" // получение метаданных/длины
  | "pass1" // первый проход двухпроходного кодирования
  | "pass2" // второй проход
  | "encoding" // аудио-кодирование
  | "compressing" // универсальная стадия (картинки/прочее)
  | "done"
  | "error"
  | "canceled";

export type CompressPayload = {
  inputPath: string;
  outDir?: string | null;

  mode: CompressMode;
  /** целевой размер (МБ), если mode === "size" */
  targetMB?: number;
  /** целевой %, если mode === "percent" (1–99) */
  targetPercent?: number;

  /** фото: jpeg|webp, по умолчанию 'jpeg' */
  imageFormat?: "jpeg" | "webp";

  /** аудио битрейт (кбит/с) на видео, по умолчанию 160 */
  audioBitrateK?: number;
};

export type CompressMeta = {
  // флаги типа входного файла
  isImage?: boolean;
  isAudio?: boolean;
  isVideo?: boolean;

  // инфо
  durationSec?: number;
  sizeMB?: number;
  ext?: string;

  // для UI
  title?: string; // имя выходного файла для карточки
  thumbnail?: string; // file://… для превью
  jobType?: "compress"; // чтобы renderer клал карточку во вкладку "Сжать"
};

export type CompressProgress = {
  id: string;
  stage: CompressStage;
  percent?: number;
  filepath?: string;
  message?: string;
  meta?: CompressMeta;
};
