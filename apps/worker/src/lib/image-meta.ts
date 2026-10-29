import { assertNever } from "../types";

export type ImageFormat = "jpeg" | "png" | "webp" | "heic";

export type ImageMeta = {
  width: number | null;
  height: number | null;
  orientation: number;
  takenAt: string | null;
};

const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
  "heif",
]);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length && i < bytes.length; i++)
    out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

export function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (ascii(bytes, 4, 4) === "ftyp" && HEIC_BRANDS.has(ascii(bytes, 8, 4))) return "heic";
  return null;
}

export function contentTypeFormat(contentType: string): ImageFormat | null {
  switch (contentType) {
    case "image/jpeg":
      return "jpeg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
    case "image/heif":
      return "heic";
    default:
      return null;
  }
}

export function describeFormat(format: ImageFormat): ImageFormat {
  switch (format) {
    case "jpeg":
    case "png":
    case "webp":
    case "heic":
      return format;
    default:
      return assertNever(format);
  }
}

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

type Tiff = { view: DataView; little: boolean; base: number };

function openTiff(bytes: Uint8Array, start: number, end: number): Tiff | null {
  if (end - start < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  const order = view.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const little = order === 0x4949;
  if (view.getUint16(2, little) !== 42) return null;
  return { view, little, base: start };
}

function readIfd(
  tiff: Tiff,
  offset: number,
): Map<number, { type: number; count: number; at: number }> {
  const out = new Map<number, { type: number; count: number; at: number }>();
  const { view, little } = tiff;
  if (offset < 0 || offset + 2 > view.byteLength) return out;
  const n = view.getUint16(offset, little);
  for (let i = 0; i < n; i++) {
    const e = offset + 2 + i * 12;
    if (e + 12 > view.byteLength) break;
    const type = view.getUint16(e + 2, little);
    const count = view.getUint32(e + 4, little);
    const size = type === 3 ? 2 : type === 4 ? 4 : 1;
    const at = count * size <= 4 ? e + 8 : view.getUint32(e + 8, little);
    out.set(view.getUint16(e, little), { type, count, at });
  }
  return out;
}

function parseExif(
  bytes: Uint8Array,
  start: number,
  end: number,
): { orientation: number; takenAt: string | null } {
  const result = { orientation: 1, takenAt: null as string | null };
  const tiff = openTiff(bytes, start, end);
  if (!tiff) return result;
  const { view, little } = tiff;
  const ifd0 = readIfd(tiff, view.getUint32(4, little));
  const orientation = ifd0.get(0x0112);
  if (orientation && orientation.at + 2 <= view.byteLength) {
    const value = view.getUint16(orientation.at, little);
    if (value >= 1 && value <= 8) result.orientation = value;
  }
  const exifPointer = ifd0.get(0x8769);
  if (exifPointer && exifPointer.at + 4 <= view.byteLength) {
    const exif = readIfd(tiff, view.getUint32(exifPointer.at, little));
    const original = exif.get(0x9003);
    if (original && original.at + original.count <= view.byteLength) {
      const text = ascii(bytes, tiff.base + original.at, original.count).replace(/\0.*$/s, "");
      const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
      if (m) result.takenAt = `${m.slice(1, 4).join("-")}T${m.slice(4, 7).join(":")}`;
    }
  }
  return result;
}

function parseJpeg(bytes: Uint8Array): ImageMeta {
  const meta: ImageMeta = { width: null, height: null, orientation: 1, takenAt: null };
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = bytes[pos + 1] ?? 0;
    if (marker === 0xff) {
      pos++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const length = ((bytes[pos + 2] ?? 0) << 8) | (bytes[pos + 3] ?? 0);
    const body = pos + 4;
    const end = pos + 2 + length;
    if (marker === 0xe1 && ascii(bytes, body, 6) === "Exif\0\0") {
      const exif = parseExif(bytes, body + 6, Math.min(end, bytes.length));
      meta.orientation = exif.orientation;
      meta.takenAt = exif.takenAt;
    } else if (SOF_MARKERS.has(marker) && body + 5 <= bytes.length) {
      meta.height = ((bytes[body + 1] ?? 0) << 8) | (bytes[body + 2] ?? 0);
      meta.width = ((bytes[body + 3] ?? 0) << 8) | (bytes[body + 4] ?? 0);
    }
    pos = end;
  }
  return meta;
}

function parsePng(bytes: Uint8Array): ImageMeta {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ok = bytes.length >= 24 && ascii(bytes, 12, 4) === "IHDR";
  return {
    width: ok ? view.getUint32(16) : null,
    height: ok ? view.getUint32(20) : null,
    orientation: 1,
    takenAt: null,
  };
}

function parseWebp(bytes: Uint8Array): ImageMeta {
  const meta: ImageMeta = { width: null, height: null, orientation: 1, takenAt: null };
  const chunk = ascii(bytes, 12, 4);
  const u24 = (i: number): number =>
    (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16);
  if (chunk === "VP8X" && bytes.length >= 30) {
    meta.width = u24(24) + 1;
    meta.height = u24(27) + 1;
  } else if (chunk === "VP8L" && bytes.length >= 25) {
    const b = (i: number): number => bytes[i] ?? 0;
    meta.width = (b(21) | ((b(22) & 0x3f) << 8)) + 1;
    meta.height = ((b(22) >> 6) | (b(23) << 2) | ((b(24) & 0x0f) << 10)) + 1;
  } else if (chunk === "VP8 " && bytes.length >= 30) {
    meta.width = ((bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8)) & 0x3fff;
    meta.height = ((bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8)) & 0x3fff;
  }
  return meta;
}

export function readImageMeta(bytes: Uint8Array, format: ImageFormat): ImageMeta {
  switch (format) {
    case "jpeg":
      return parseJpeg(bytes);
    case "png":
      return parsePng(bytes);
    case "webp":
      return parseWebp(bytes);
    case "heic":
      return { width: null, height: null, orientation: 1, takenAt: null };
    default:
      return assertNever(format);
  }
}
