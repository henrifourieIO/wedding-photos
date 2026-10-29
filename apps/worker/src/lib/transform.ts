import { PhotonImage, SamplingFilter, resize } from "@cf-wasm/photon";

export type Variant = { bytes: Uint8Array; width: number; height: number };

const JPEG_QUALITY = 82;

function orient(
  rgba: Uint8Array,
  w: number,
  h: number,
  orientation: number,
): { rgba: Uint8Array; width: number; height: number } {
  if (orientation === 1) return { rgba, width: w, height: h };
  const swap = orientation >= 5;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      switch (orientation) {
        case 2:
          nx = w - 1 - x;
          ny = y;
          break;
        case 3:
          nx = w - 1 - x;
          ny = h - 1 - y;
          break;
        case 4:
          nx = x;
          ny = h - 1 - y;
          break;
        case 5:
          nx = y;
          ny = x;
          break;
        case 6:
          nx = h - 1 - y;
          ny = x;
          break;
        case 7:
          nx = h - 1 - y;
          ny = w - 1 - x;
          break;
        default:
          nx = y;
          ny = w - 1 - x;
          break;
      }
      const s = (y * w + x) * 4;
      const d = (ny * ow + nx) * 4;
      out[d] = rgba[s] ?? 0;
      out[d + 1] = rgba[s + 1] ?? 0;
      out[d + 2] = rgba[s + 2] ?? 0;
      out[d + 3] = rgba[s + 3] ?? 255;
    }
  }
  return { rgba: out, width: ow, height: oh };
}

function flattenAlpha(rgba: Uint8Array): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] ?? 255;
    if (a === 255) continue;
    for (let c = 0; c < 3; c++) {
      rgba[i + c] = Math.round(((rgba[i + c] ?? 0) * a + 255 * (255 - a)) / 255);
    }
    rgba[i + 3] = 255;
  }
}

export function renderVariants(
  source: Uint8Array,
  orientation: number,
  maxEdges: readonly number[],
): Variant[] {
  const decoded = PhotonImage.new_from_byteslice(source);
  try {
    return maxEdges.map((edge) => {
      const longest = Math.max(decoded.get_width(), decoded.get_height());
      const scale = Math.min(1, edge / longest);
      const tw = Math.max(1, Math.round(decoded.get_width() * scale));
      const th = Math.max(1, Math.round(decoded.get_height() * scale));
      const scaled = scale < 1 ? resize(decoded, tw, th, SamplingFilter.Lanczos3) : decoded;
      try {
        const pixels = scaled.get_raw_pixels();
        flattenAlpha(pixels);
        const o = orient(pixels, scaled.get_width(), scaled.get_height(), orientation);
        const img = new PhotonImage(o.rgba, o.width, o.height);
        try {
          return { bytes: img.get_bytes_jpeg(JPEG_QUALITY), width: o.width, height: o.height };
        } finally {
          img.free();
        }
      } finally {
        if (scaled !== decoded) scaled.free();
      }
    });
  } finally {
    decoded.free();
  }
}
