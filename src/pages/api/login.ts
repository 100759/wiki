import type { APIRoute } from "astro";
import {
  checkRateLimit,
  recordFailure,
  recordSuccess,
  sessionCookie,
  signSession,
  verifyPassword,
} from "../../lib/session";
import {
  bootstrapAllowed,
  findUser,
  getUserRepository,
  makeUser,
  type UserRecord,
} from "../../lib/users";

export const prerender = false;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  if (first) return first;
  return request.headers.get("x-real-ip")?.trim() || "local";
}

export const POST: APIRoute = async ({ request }) => {
  let body: { name?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, code: "invalid", message: "请求体不是合法 JSON" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!name || !password) {
    return json({ ok: false, code: "invalid", message: "用户名和口令必填" }, 400);
  }

  const ip = clientIp(request);
  const limit = checkRateLimit(ip, name);
  if (!limit.allowed) {
    return json(
      {
        ok: false,
        code: "rate_limited",
        message: `尝试过于频繁，请 ${limit.retryAfterSeconds} 秒后再试`,
      },
      429,
    );
  }

  const repo = getUserRepository();
  let users: UserRecord[];
  try {
    users = await repo.load();
  } catch {
    return json({ ok: false, code: "unavailable", message: "用户表读取失败，请稍后再试" }, 503);
  }

  let user: UserRecord | null = findUser(users, name);

  // 首次部署引导：还没有用户表时，用环境变量里的口令登录 admin。
  if (!user && bootstrapAllowed(users, name)) {
    const passwordEnv = process.env.WIKI_BOOTSTRAP_PASSWORD ?? "";
    if (passwordEnv && passwordEnv === password) {
      const created = await makeUser("admin", passwordEnv, "admin");
      try {
        await repo.save([created], "chore(users): 初始化管理员");
      } catch (err) {
        // 只回粗粒度原因（GitHub 状态码），不带 token、不带堆栈。
        const status = (err as { status?: number }).status;
        const reason = typeof status === "number" && status > 0 ? `github_${status}` : "storage_error";
        return json(
          { ok: false, code: "unavailable", message: "初始化管理员失败，请稍后再试", reason },
          503,
        );
      }
      user = created;
    }
  }

  const valid = await verifyPassword(password, user ?? undefined);
  if (!user || !valid) {
    recordFailure(ip, name);
    return json({ ok: false, code: "bad_credentials", message: "用户名或口令不正确" }, 401);
  }

  recordSuccess(ip, name);
  let token: string;
  try {
    token = signSession({ uid: user.uid, name: user.name, role: user.role });
  } catch {
    return json({ ok: false, code: "server", message: "服务器未配置会话密钥，暂不能登录" }, 500);
  }

  return json(
    { ok: true, user: { uid: user.uid, name: user.name, role: user.role } },
    200,
    { "set-cookie": sessionCookie(token) },
  );
};
