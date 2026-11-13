export const MAX_IMAGE_BYTES = 800 * 1024;

export const ALLOWED_MIME = new Set(["image/webp", "image/png", "image/jpeg", "image/gif"]);

const EXPECTED_EXT: Record<string, string[]> = {
  "image/webp": [".webp"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
};

export type ImageReject = { ok: false; message: string };
export type ImageAccept = { ok: true; name: string };

/** 两个存储实现共用一套规则：类型白名单、扩展名匹配、大小上限。 */
export function validateImage(name: string, mime: string, size: number): ImageAccept | ImageReject {
  if (!ALLOWED_MIME.has(mime)) return { ok: false, message: `不支持的图片类型：${mime}` };
  const ext = (name.match(/\.[^.]+$/) ?? [""])[0].toLowerCase();
  if (!(EXPECTED_EXT[mime] ?? []).includes(ext)) {
    return { ok: false, message: `扩展名 ${ext || "(无)"} 与类型 ${mime} 不匹配` };
  }
  if (size <= 0) return { ok: false, message: "图片为空" };
  if (size > MAX_IMAGE_BYTES) return { ok: false, message: "图片超过 800KB" };
  return { ok: true, name };
}
