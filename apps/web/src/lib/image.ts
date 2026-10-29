export const MAX_DIMENSION = 4000;
const DOWNSCALE_MIN_BYTES = 1024 * 1024;

export type PreparedImage = { blob: Blob; contentType: string };

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

export function inferContentType(file: Blob & { name?: string }): string | null {
  const type = file.type.toLowerCase();
  if (ALLOWED.has(type)) return type;
  const ext = file.name?.split(".").pop()?.toLowerCase();
  if (ext === "heic" || ext === "heif") return "image/heic";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return null;
}

export async function prepareImage(file: Blob & { name?: string }): Promise<PreparedImage> {
  const contentType = inferContentType(file);
  if (!contentType) throw new Error("unsupported_type");
  const original: PreparedImage = { blob: file, contentType };
  if (file.size < DOWNSCALE_MIN_BYTES || typeof createImageBitmap !== "function") return original;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return original;
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= MAX_DIMENSION) return original;
    const scale = MAX_DIMENSION / longest;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return original;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.9);
    });
    return blob && blob.size < file.size ? { blob, contentType: "image/jpeg" } : original;
  } finally {
    bitmap.close();
  }
}
