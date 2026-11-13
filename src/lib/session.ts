import { createHmac, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import type { AstroCookies } from "astro";

/* ------------------------------------------------------------------ *
 * M2 模块 F：真实会话与口令
 *  - 口令：PBKDF2-SHA256，600k 轮，每用户独立 salt（OWASP 建议值）
 *  - 会话：HMAC-SHA256 签名的 Cookie，服务端不存 session（无 Blob/KV 也能用）
 *  - M1 那种按 Cookie 直读角色的登录方式已整体删除，Cookie 无法伪造身份
 * ------------------------------------------------------------------ */

export type Role = "admin" | "editor" | "viewer";

export interface Session {
  uid: string;
  name: string;
  role: Role;
}

export const SESSION_COOKIE = "wiki_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;
export const PBKDF2_ITERATIONS = 600_000;

export function isRole(value: unknown): value is Role {
  return value === "admin" || value === "editor" || value === "viewer";
}

/* --------------------------- 口令 --------------------------- */

export interface PasswordHash {
  salt: string;
  hash: string;
  iterations: number;
}

function pbkdf2Async(password: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, 32, "sha256", (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<PasswordHash> {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("口令至少 8 位");
  }
  const salt = randomBytes(16);
  const derived = await pbkdf2Async(password, salt, iterations);
  return { salt: salt.toString("base64"), hash: derived.toString("base64"), iterations };
}

export async function verifyPassword(
  password: string,
  record: PasswordHash | null | undefined,
): Promise<boolean> {
  if (!record || typeof record.hash !== "string" || typeof record.salt !== "string") return false;
  if (typeof password !== "string" || password.length === 0) return false;
  const iterations = Number.isFinite(record.iterations) ? record.iterations : PBKDF2_ITERATIONS;
  const expected = Buffer.from(record.hash, "base64");
  const derived = await pbkdf2Async(password, Buffer.from(record.salt, "base64"), iterations);
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}

/* --------------------------- 会话 --------------------------- */

function secret(): string | null {
  const value = (process.env.JWT_SECRET ?? "").trim();
  return value.length >= 16 ? value : null;
}

function toBase64Url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

export function signSession(user: Session, now = Date.now()): string {
  const key = secret();
  if (!key) throw new Error("JWT_SECRET 未配置或长度不足 16，拒绝签发会话");
  const payload = {
    uid: user.uid,
    name: user.name,
    role: user.role,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  };
  const body = toBase64Url(JSON.stringify(payload));
  const mac = createHmac("sha256", key).update(body).digest();
  return `${body}.${toBase64Url(mac)}`;
}

export function verifySessionToken(token: string, now = Date.now()): Session | null {
  const key = secret();
  if (!key || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const macPart = token.slice(dot + 1);
  const expected = createHmac("sha256", key).update(body).digest();
  let actual: Buffer;
  try {
    actual = fromBase64Url(macPart);
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let payload: { uid?: unknown; name?: unknown; role?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(fromBase64Url(body).toString("utf8")) as typeof payload;
  } catch {
    return null;
  }
  if (!isRole(payload.role)) return null;
  if (typeof payload.uid !== "string" || typeof payload.name !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
  return { uid: payload.uid, name: payload.name, role: payload.role };
}

export function getSession(cookies: AstroCookies): Session | null {
  const token = cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export function sessionCookie(token: string): string {
  const secure = (process.env.WIKI_INSECURE_COOKIE ?? "") !== "1";
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/* ------------------------- 登录限流 ------------------------- */

const MAX_FAILURES = 5;          // 单账号
const MAX_IP_FAILURES = 20;       // 单 IP 跨账号（共享出口 IP 不至于第 6 次就误伤）
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

interface Bucket {
  failures: number;
  firstAt: number;
  lockedUntil: number;
}

const buckets = new Map<string, Bucket>();

function keyOf(kind: "ip" | "user", value: string): string {
  return `${kind}:${value.trim().toLowerCase()}`;
}

export interface RateLimitState {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function checkRateLimit(ip: string, user: string, now = Date.now()): RateLimitState {
  for (const key of [keyOf("ip", ip), keyOf("user", user)]) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (bucket.lockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((bucket.lockedUntil - now) / 1000) };
    }
    if (bucket.lockedUntil > 0) buckets.delete(key);
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordFailure(ip: string, user: string, now = Date.now()): void {
  // ip 桶按 IP 聚合所有用户名，阈值更高：既能挡住换名撞库，也不会让共享出口挨一刀。
  for (const key of [keyOf("ip", ip), keyOf("user", user)]) {
    const limit = key.startsWith("ip:") ? MAX_IP_FAILURES : MAX_FAILURES;
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.firstAt > WINDOW_MS) {
      buckets.set(key, { failures: 1, firstAt: now, lockedUntil: 0 });
      continue;
    }
    bucket.failures += 1;
    if (bucket.failures >= limit) bucket.lockedUntil = now + LOCK_MS;
  }
}

export function recordSuccess(ip: string, user: string): void {
  buckets.delete(keyOf("ip", ip));
  buckets.delete(keyOf("user", user));
}

/** 仅用于自测：清空限流状态。 */
export function resetRateLimits(): void {
  buckets.clear();
}
