import { PhotonImage } from "@cf-wasm/photon";

export function gradient(width: number, height: number): PhotonImage {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      px[i] = (x * 255) / width;
      px[i + 1] = (y * 255) / height;
      px[i + 2] = 128;
      px[i + 3] = 255;
    }
  }
  return new PhotonImage(px, width, height);
}

export function jpeg(width: number, height: number): Uint8Array {
  return gradient(width, height).get_bytes_jpeg(90);
}

export function png(width: number, height: number): Uint8Array {
  return gradient(width, height).get_bytes();
}

function u16(n: number): number[] {
  return [n & 0xff, n >> 8];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

export function withExif(
  base: Uint8Array,
  opts: { orientation: number; takenAt: string },
): Uint8Array {
  const date = Array.from(new TextEncoder().encode(`${opts.takenAt}\0`));
  const gpsIfdOffset = 8 + 2 + 12 * 3 + 4;
  const exifIfdOffset = gpsIfdOffset + 2 + 12 + 4;
  const dateOffset = exifIfdOffset + 2 + 12 + 4;
  const tiff = [
    0x49,
    0x49,
    0x2a,
    0x00,
    ...u32(8),
    ...u16(3),
    ...u16(0x0112),
    ...u16(3),
    ...u32(1),
    ...u16(opts.orientation),
    0,
    0,
    ...u16(0x8769),
    ...u16(4),
    ...u32(1),
    ...u32(exifIfdOffset),
    ...u16(0x8825),
    ...u16(4),
    ...u32(1),
    ...u32(gpsIfdOffset),
    ...u32(0),
    ...u16(1),
    ...u16(0x0002),
    ...u16(2),
    ...u32(2),
    0x4e,
    0x00,
    0,
    0,
    ...u32(0),
    ...u16(1),
    ...u16(0x9003),
    ...u16(2),
    ...u32(date.length),
    ...u32(dateOffset),
    ...u32(0),
    ...date,
  ];
  const payload = [...new TextEncoder().encode("Exif\0\0"), ...tiff];
  const segment = [
    0xff,
    0xe1,
    ...[(payload.length + 2) >> 8, (payload.length + 2) & 0xff],
    ...payload,
  ];
  const out = new Uint8Array(base.length + segment.length);
  out.set(base.subarray(0, 2));
  out.set(segment, 2);
  out.set(base.subarray(2), 2 + segment.length);
  return out;
}

export function hasExifSegment(bytes: Uint8Array): boolean {
  let pos = 2;
  while (pos + 4 <= bytes.length && bytes[pos] === 0xff) {
    const marker = bytes[pos + 1] ?? 0;
    if (marker === 0xda) return false;
    if (marker === 0xe1) return true;
    pos += 2 + (((bytes[pos + 2] ?? 0) << 8) | (bytes[pos + 3] ?? 0));
  }
  return false;
}

export function dims(bytes: Uint8Array): { width: number; height: number } {
  const img = PhotonImage.new_from_byteslice(bytes);
  return { width: img.get_width(), height: img.get_height() };
}
