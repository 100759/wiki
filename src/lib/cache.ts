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
    // 登录用户的页面只有他自己能看，交给浏览器私有缓存，站内跳转不必每次重新渲染。
    headers.set("Cache-Control", "private, max-age=15");
    return;
  }
  const maxAge = options.maxAge ?? 180;
  const swr = options.swr ?? 1800;
  headers.set(
    "Cache-Control",
    `public, max-age=${Math.min(maxAge, 30)}, s-maxage=${maxAge}, stale-while-revalidate=${swr}`,
  );
}
