import type { APIRoute } from "astro";
import { getSession, isRole } from "../../lib/session";
import {
  addUser,
  getUserRepository,
  removeUser,
  setUserPassword,
  setUserRole,
  type UserRecord,
} from "../../lib/users";

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function publicView(user: UserRecord): { uid: string; name: string; role: string } {
  return { uid: user.uid, name: user.name, role: user.role };
}

export const GET: APIRoute = async ({ cookies }) => {
  const session = getSession(cookies);
  if (!session) return json({ ok: false, code: "unauthorized", message: "请先登录" }, 401);
  if (session.role !== "admin") return json({ ok: false, code: "forbidden", message: "仅管理员可查看成员" }, 403);

  const users = await getUserRepository().load();
  return json({ ok: true, users: users.map(publicView) });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const session = getSession(cookies);
  if (!session) return json({ ok: false, code: "unauthorized", message: "请先登录" }, 401);
  if (session.role !== "admin") return json({ ok: false, code: "forbidden", message: "仅管理员可管理成员" }, 403);

  let body: { action?: unknown; name?: unknown; role?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, code: "invalid", message: "请求体不是合法 JSON" }, 400);
  }

  const action = String(body.action ?? "");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const repo = getUserRepository();

  try {
    if (action === "add") {
      const role = isRole(body.role) ? body.role : "editor";
      const password = typeof body.password === "string" ? body.password : "";
      if (password.length < 8) return json({ ok: false, code: "invalid", message: "口令至少 8 位" }, 400);
      const user = await addUser(repo, name, password, role);
      return json({ ok: true, user: publicView(user) });
    }

    if (action === "role") {
      if (!isRole(body.role)) return json({ ok: false, code: "invalid", message: "角色不合法" }, 400);
      const user = await setUserRole(repo, name, body.role);
      return json({ ok: true, user: publicView(user) });
    }

    if (action === "reset") {
      const password = typeof body.password === "string" ? body.password : "";
      if (password.length < 8) return json({ ok: false, code: "invalid", message: "口令至少 8 位" }, 400);
      await setUserPassword(repo, name, password);
      return json({ ok: true });
    }

    if (action === "remove") {
      await removeUser(repo, name);
      return json({ ok: true });
    }
  } catch (err) {
    return json({ ok: false, code: "invalid", message: (err as Error).message }, 400);
  }

  return json({ ok: false, code: "invalid", message: `未知操作：${action}` }, 400);
};
