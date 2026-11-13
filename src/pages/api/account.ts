import type { APIRoute } from "astro";
import { getSession, verifyPassword } from "../../lib/session";
import { findUser, getUserRepository, setUserPassword } from "../../lib/users";

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 自助改口令：必须先验证旧口令，防止会话被借用后直接改密码。 */
export const POST: APIRoute = async ({ request, cookies }) => {
  const session = getSession(cookies);
  if (!session) return json({ ok: false, code: "unauthorized", message: "请先登录" }, 401);

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, code: "invalid", message: "请求体不是合法 JSON" }, 400);
  }

  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body.newPassword === "string" ? body.newPassword : "";
  if (next.length < 12) {
    return json({ ok: false, code: "invalid", message: "新口令至少 12 位" }, 400);
  }

  const repo = getUserRepository();
  const users = await repo.load();
  const me = findUser(users, session.name);
  if (!me) return json({ ok: false, code: "invalid", message: "账号不存在" }, 400);

  if (!(await verifyPassword(current, me))) {
    return json({ ok: false, code: "invalid", message: "当前口令不正确" }, 403);
  }

  try {
    await setUserPassword(repo, session.name, next);
  } catch (err) {
    return json({ ok: false, code: "invalid", message: (err as Error).message }, 400);
  }
  return json({ ok: true });
};
