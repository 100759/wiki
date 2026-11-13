import type { APIRoute } from "astro";
import { getSession } from "../../lib/session";
import { getStore } from "../../lib/storage";

export const prerender = false;

const MAX_BYTES = 800 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * 图片上传：正文走 /api/save，图片走这里。
 * 用原始二进制而不是 base64，避免 1MB 请求体上限被 800KB 图撑爆（base64 会到 1.06MB）。
 */
export const POST: APIRoute = async ({ request, url, cookies }) => {
  const actor = getSession(cookies);
  if (!actor) return json({ ok: false, code: "unauthorized", message: "请先登录" }, 401);
  if (actor.role === "viewer") {
    return json({ ok: false, code: "forbidden", message: "viewer 角色不能上传图片" }, 403);
  }

  const pagePath = url.searchParams.get("path") ?? "";
  if (!pagePath) return json({ ok: false, code: "invalid", message: "缺少 path" }, 400);

  const mime = (request.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  const rawName = request.headers.get("x-file-name") ?? "";
  let name = "image.webp";
  try {
    name = rawName ? decodeURIComponent(rawName) : name;
  } catch {
    return json({ ok: false, code: "invalid", message: "文件名编码不合法" }, 400);
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return json({ ok: false, code: "invalid", message: "图片超过 800KB" }, 413);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return json({ ok: false, code: "invalid", message: "读取图片失败" }, 400);
  }
  if (bytes.byteLength === 0) return json({ ok: false, code: "invalid", message: "图片为空" }, 400);
  if (bytes.byteLength > MAX_BYTES) {
    return json({ ok: false, code: "invalid", message: "图片超过 800KB" }, 413);
  }

  const result = await getStore().uploadImage({ pagePath, name, mime, bytes, actor });
  if (result.ok) return json(result, 200);
  const status = result.code === "forbidden" ? 403 : 400;
  return json(result, status);
};
