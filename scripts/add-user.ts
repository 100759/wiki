/**
 * 新增用户：口令从环境变量读，不落命令行历史、不进仓库。
 *   WIKI_USER_NAME=张三 WIKI_USER_PASSWORD='至少8位' WIKI_USER_ROLE=editor npm run user:add
 * 有 GitHub 凭据时写仓库 _system/users.json；否则写本地 data/users.json。
 */
import { addUser, getUserRepository } from "../src/lib/users";
import type { Role } from "../src/lib/session";

async function main(): Promise<void> {
  const name = (process.env.WIKI_USER_NAME ?? "").trim();
  const password = process.env.WIKI_USER_PASSWORD ?? "";
  const role = (process.env.WIKI_USER_ROLE ?? "editor").trim() as Role;

  if (!name || !password) {
    console.error("需要 WIKI_USER_NAME 与 WIKI_USER_PASSWORD");
    process.exit(1);
  }
  if (role !== "admin" && role !== "editor" && role !== "viewer") {
    console.error("WIKI_USER_ROLE 只能是 admin / editor / viewer");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("口令至少 8 位");
    process.exit(1);
  }

  const user = await addUser(getUserRepository(), name, password, role);
  console.log(`已创建用户：${user.name}（${user.role}），口令只保存哈希`);
}

void main();
