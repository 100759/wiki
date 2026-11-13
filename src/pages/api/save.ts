import type { APIRoute } from "astro";
import { getSession } from "../../lib/session";
import { getStore } from "../../lib/storage";

export const prerender = false;

const MAX_IMAGE_BYTES = 800 * 1024;
const ALLOWED_MIME = new Set(["image/webp", "image/png", "image/jpeg", "image/gif"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

interface SaveBody {
  path?: unknown;
  title?: unknown;
  markdown?: unknown;
  baseSha?: unknown;
  images?: unknown;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const actor = getSession(cookies);

  // F 验收：没有有效签名会话一律 401，不接受任何可伪造的角色 Cookie。
  if (!actor) {
    return json({ ok: false, code: "unauthorized", message: "请先登录" }, 401);
  }

  // D 验收：viewer 一律 forbidden。
  if (actor.role === "viewer") {
    return json({ ok: false, code: "forbidden", message: "viewer 角色没有保存权限" }, 403);
  }

  let body: SaveBody;
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    return json({ ok: false, code: "invalid", message: "请求体不是合法 JSON" }, 400);
  }

  if (typeof body.path !== "string" || typeof body.title !== "string" || typeof body.markdown !== "string") {
    return json({ ok: false, code: "invalid", message: "path / title / markdown 必填" }, 400);
  }
  if (body.baseSha !== null && typeof body.baseSha !== "string") {
    return json({ ok: false, code: "invalid", message: "baseSha 必须是字符串或 null" }, 400);
  }

  const images: { name: string; bytes: Uint8Array; mime: string }[] = [];
  if (body.images !== undefined) {
    if (!Array.isArray(body.images)) {
      return json({ ok: false, code: "invalid", message: "images 必须是数组" }, 400);
    }
    for (const item of body.images) {
      if (!item || typeof item !== "object") {
        return json({ ok: false, code: "invalid", message: "图片项不合法" }, 400);
      }
      const { name, mime, bytesBase64 } = item as Record<string, unknown>;
      if (typeof name !== "string" || typeof mime !== "string" || typeof bytesBase64 !== "string") {
        return json({ ok: false, code: "invalid", message: "图片字段不完整" }, 400);
      }
      if (!ALLOWED_MIME.has(mime)) {
        return json({ ok: false, code: "invalid", message: `不支持的图片类型：${mime}` }, 400);
      }
      const bytes = Buffer.from(bytesBase64, "base64");
      if (bytes.byteLength === 0) {
        return json({ ok: false, code: "invalid", message: `图片 ${name} 为空` }, 400);
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return json({ ok: false, code: "invalid", message: `图片 ${name} 超过 800KB` }, 413);
      }
      images.push({ name, mime, bytes: new Uint8Array(bytes) });
    }
  }

  const result = await getStore().savePage({
    path: body.path,
    title: body.title,
    markdown: body.markdown,
    baseSha: body.baseSha,
    images,
    actor,
  });

  if (result.ok) return json(result, 200);
  const status = result.code === "conflict" ? 409 : result.code === "forbidden" ? 403 : 400;
  return json(result, status);
};
