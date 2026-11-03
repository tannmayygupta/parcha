import { sha256Hex } from "../shared/bytes";

/**
 * Photos are the most dangerous thing a journalist uploads: they carry GPS position, device
 * serial numbers and timestamps. Re-drawing the picture onto a canvas and re-encoding it keeps
 * only the pixels, so ALL of that metadata is dropped, and it also shrinks the file (storage on
 * Swarm is paid for by size).
 */
export const MAX_INPUT_BYTES = 30 * 1024 * 1024;
export const MAX_EDGE = 1600;

export interface ProcessedImage {
  path: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  originalBytes: number;
}

export function fitWithin(w: number, h: number, max = MAX_EDGE): { w: number; h: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

export async function processImage(file: File): Promise<ProcessedImage> {
  if (!file.type.startsWith("image/")) throw new Error("That file is not an image.");
  if (file.size > MAX_INPUT_BYTES) throw new Error("That image is larger than 30 MB. Please pick a smaller one.");

  let bitmap: ImageBitmap;
  try {
    // 'from-image' applies the camera's rotation before the metadata is thrown away.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("Couldn't read that image. Try saving it as JPEG or PNG first.");
  }
  const { w, h } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser can't process images.");
  ctx.fillStyle = "#ffffff"; // JPEG has no transparency
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.82));
  if (!blob) throw new Error("Couldn't compress that image.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const path = `media/${sha256Hex(bytes).slice(0, 16)}.jpg`;
  return { path, bytes, width: w, height: h, originalBytes: file.size };
}
