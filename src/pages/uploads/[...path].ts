import type { APIRoute } from "astro";
import { promises as fs } from "node:fs";
import path from "node:path";
import { defaultDataDir } from "../../lib/storage";

export const prerender = false;

const MIME: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/** M1 本地图片读路径：/uploads/<pageId>/<file> → data/uploads/... */
export const GET: APIRoute = async ({ params }) => {
  const rel = params.path ?? "";
  const uploadsRoot = path.join(defaultDataDir(), "uploads");
  const abs = path.resolve(uploadsRoot, rel);
  if (!abs.startsWith(path.resolve(uploadsRoot) + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const bytes = await fs.readFile(abs);
    const type = MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
};
