import type { APIRoute } from "astro";
import { promises as fs } from "node:fs";
import path from "node:path";
import { defaultDataDir } from "../../lib/storage";

export const prerender = false;

// 只放行真正的位图；SVG 与站点同源，绝不按 image/svg+xml 返回（可内嵌脚本）。
const MIME: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

/**
 * M1 本地图片读路径：/uploads/<pageId>/<file> → data/uploads/...
 * M2 迁移：图片读路径统一走 /img/（公共仓库 raw 302 / 私有仓库带 token 代理），本路由届时删除。
 */
export const GET: APIRoute = async ({ params }) => {
  const rel = params.path ?? "";
  const uploadsRoot = path.join(defaultDataDir(), "uploads");
  const abs = path.resolve(uploadsRoot, rel);
  if (!abs.startsWith(path.resolve(uploadsRoot) + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const bytes = await fs.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] ?? "application/octet-stream";
    const isAllowedImage = ext in MIME;

    const headers: Record<string, string> = {
      "content-type": type,
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    };
    // 白名单外的文件（如 .svg）一律下载，不在同源下渲染。
    if (!isAllowedImage) {
      headers["content-disposition"] = `attachment; filename="${path.basename(abs).replace(/["\\]/g, "_")}"`;
    }

    return new Response(new Uint8Array(bytes), { status: 200, headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
};
