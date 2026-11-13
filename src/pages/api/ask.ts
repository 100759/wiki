import type { APIRoute } from "astro";
import { chat, type ChatMessage } from "../../lib/ai";
import { pathToSlug } from "../../lib/ids";
import { retrievePages } from "../../lib/search";
import { getStore } from "../../lib/storage";

export const prerender = false;

/** 公开站不要求登录，按 IP 限流，防止把模型额度刷掉。 */
const MAX_PER_HOUR = 20;
const WINDOW_MS = 3600 * 1000;
const usage = new Map<string, { count: number; since: number }>();

function allow(uid: string, now = Date.now()): number {
  const entry = usage.get(uid);
  if (!entry || now - entry.since > WINDOW_MS) {
    usage.set(uid, { count: 1, since: now });
    return 0;
  }
  entry.count += 1;
  if (entry.count > MAX_PER_HOUR) return Math.ceil((entry.since + WINDOW_MS - now) / 1000);
  return 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function clientIp(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const parts = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] || "local";
}

export const POST: APIRoute = async ({ request }) => {
  let body: { q?: unknown; path?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, code: "invalid", message: "请求体不是合法 JSON" }, 400);
  }
  const question = typeof body.q === "string" ? body.q.trim() : "";
  if (question.length < 2) return json({ ok: false, code: "invalid", message: "问题太短" }, 400);
  if (question.length > 500) return json({ ok: false, code: "invalid", message: "问题太长" }, 400);

  const wait = allow(clientIp(request));
  if (wait > 0) {
    return json({ ok: false, code: "rate_limited", message: `提问太频繁，请 ${Math.ceil(wait / 60)} 分钟后再试` }, 429);
  }

  const store = getStore();

  // 当前页优先入上下文
  const contexts: { path: string; title: string; slug: string; markdown: string }[] = [];
  const seen = new Set<string>();
  const currentPath = typeof body.path === "string" ? body.path : "";
  if (currentPath) {
    const current = await store.getPageByPath(currentPath).catch(() => null);
    if (current) {
      contexts.push({ path: current.path, title: current.title, slug: pathToSlug(current.path), markdown: current.markdown });
      seen.add(current.path);
    }
  }
  for (const item of await retrievePages(store, question, 3)) {
    if (seen.has(item.path)) continue;
    contexts.push(item);
    seen.add(item.path);
    if (contexts.length >= 3) break;
  }

  if (contexts.length === 0) {
    return json({ ok: true, answer: "站内还没有内容，先写一页再来问。", sources: [] });
  }

  const contextText = contexts
    .map((item, index) => `【${index + 1}】${item.title}（${item.path}）\n${item.markdown.slice(0, 1800)}`)
    .join("\n\n---\n\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是这个共创 Wiki 的站内助手。只根据提供的资料回答，不要编造资料外的内容。" +
        "回答用简体中文，先给结论，再补必要的步骤或细节，控制在 400 字内。" +
        "如果资料不足以回答，直接说明缺少什么，不要猜测。引用时用【1】【2】标注来源编号。",
    },
    { role: "user", content: `问题：${question}\n\n资料：\n${contextText}` },
  ];

  const result = await chat(messages);
  if (!result.ok) {
    const status = result.code === "not_configured" ? 503 : result.code === "timeout" ? 504 : 502;
    return json({ ok: false, code: result.code, message: result.message }, status);
  }

  return json({
    ok: true,
    answer: result.text,
    sources: contexts.map((item) => ({ title: item.title, path: item.path, slug: item.slug })),
  });
};
