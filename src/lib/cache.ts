import type { AstroCookies } from "astro";
import { getSession } from "./session";

/**
 * 阅读型页面交给边缘缓存，登录用户直连（他们要看编辑按钮，不能共享缓存）。
 * 内容保存后最迟 maxAge 秒可见；swr 让过期期间仍先返回旧页再后台刷新。
 */
export function setPageCache(
  cookies: AstroCookies,
  headers: Headers,
  options: { maxAge?: number; swr?: number } = {},
): void {
  const session = getSession(cookies);
  if (session) {
    headers.set("Cache-Control", "private, no-store");
    return;
  }
  const maxAge = options.maxAge ?? 60;
  const swr = options.swr ?? 600;
  headers.set("Cache-Control", `public, s-maxage=${maxAge}, stale-while-revalidate=${swr}`);
}
