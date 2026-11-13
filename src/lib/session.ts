import type { AstroCookies } from "astro";

export type Role = "admin" | "editor" | "viewer";

export interface MockUser {
  uid: string;
  name: string;
  role: Role;
}

/** M1 固定账号：不实现邀请码、PBKDF2、JWT（M2 模块 F）。 */
export const MOCK_USERS: Record<Role, MockUser> = {
  admin: { uid: "u-admin", name: "管理员", role: "admin" },
  editor: { uid: "u-editor", name: "编辑者", role: "editor" },
  viewer: { uid: "u-viewer", name: "读者", role: "viewer" },
};

export const SESSION_COOKIE = "mock_role";

export function isRole(value: unknown): value is Role {
  return value === "admin" || value === "editor" || value === "viewer";
}

/** 从 Cookie 取角色，缺省 editor（便于本地演示）。 */
export function getSession(cookies: AstroCookies): MockUser {
  const raw = cookies.get(SESSION_COOKIE)?.value;
  return MOCK_USERS[isRole(raw) ? raw : "editor"];
}
