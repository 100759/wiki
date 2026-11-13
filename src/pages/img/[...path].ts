import type { APIRoute } from "astro";
import { createImageResolver, ImageError } from "../../lib/images";

export const prerender = false;

function errorResponse(err: unknown): Response {
  if (err instanceof ImageError) {
    const status =
      err.code === "not_implemented"
        ? 501
        : err.code === "not_configured"
          ? 500
          : err.code === "invalid_mode"
            ? 500
            : 400;
    return new Response(JSON.stringify({ ok: false, code: err.code, message: err.message }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(JSON.stringify({ ok: false, code: "internal", message: "图片读取失败" }), {
    status: 500,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export const GET: APIRoute = async ({ params, request }) => {
  try {
    const resolver = createImageResolver();
    return await resolver.resolve(params.path ?? "", request);
  } catch (err) {
    return errorResponse(err);
  }
};
