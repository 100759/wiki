import { promises as fs } from "node:fs";
import path from "node:path";
import { commitFiles } from "./gitcommit";
import { type GithubClient } from "./github";
import { hashPassword, isRole, PBKDF2_ITERATIONS, type PasswordHash, type Role } from "./session";
import { getGithubClient } from "./storage";

/* ------------------------------------------------------------------ *
 * 用户表
 *  - 线上（有 GitHub 凭据）：仓库内 _system/users.json，只存哈希与角色
 *  - 本地（无凭据）：data/users.json，同一份结构，便于离线跑通
 * ------------------------------------------------------------------ */

export const USERS_PATH = "_system/users.json";

export interface UserRecord extends PasswordHash {
  uid: string;
  name: string;
  role: Role;
}

export interface UserRepository {
  load(): Promise<UserRecord[]>;
  save(users: UserRecord[], message: string): Promise<void>;
}

function parseUsers(raw: string): UserRecord[] {
  try {
    const parsed = JSON.parse(raw) as { users?: unknown };
    if (!Array.isArray(parsed.users)) return [];
    return parsed.users
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .filter(
        (item) =>
          typeof item.uid === "string" &&
          typeof item.name === "string" &&
          isRole(item.role) &&
          typeof item.salt === "string" &&
          typeof item.hash === "string",
      )
      .map((item) => ({
        uid: String(item.uid),
        name: String(item.name),
        role: item.role as Role,
        salt: String(item.salt),
        hash: String(item.hash),
        iterations: Number(item.iterations) || PBKDF2_ITERATIONS,
      }));
  } catch {
    return [];
  }
}

function serializeUsers(users: UserRecord[]): string {
  return `${JSON.stringify({ version: 1, users }, null, 2)}\n`;
}

export class LocalUserRepository implements UserRepository {
  private readonly file: string;

  constructor(dataDir = process.env.WIKI_DATA_DIR ?? "data") {
    this.file = path.resolve(process.cwd(), dataDir, "users.json");
  }

  async load(): Promise<UserRecord[]> {
    try {
      return parseUsers(await fs.readFile(this.file, "utf8"));
    } catch {
      return [];
    }
  }

  async save(users: UserRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, serializeUsers(users), "utf8");
  }
}

export class GithubUserRepository implements UserRepository {
  constructor(private readonly client: GithubClient) {}

  async load(): Promise<UserRecord[]> {
    const tree = await this.client.tree();
    const entry = tree.entries.get(USERS_PATH);
    if (!entry) return [];
    return parseUsers(await this.client.readBlob(entry.sha));
  }

  async save(users: UserRecord[], message: string): Promise<void> {
    const tree = await this.client.tree();
    const current = tree.entries.get(USERS_PATH)?.sha ?? null;
    const outcome = await commitFiles(this.client, {
      message,
      files: [{ path: USERS_PATH, content: serializeUsers(users) }],
      expected: { [USERS_PATH]: current },
    });
    if (!outcome.ok) throw new Error("用户表写入冲突，请重试");
  }
}

export function findUser(users: UserRecord[], name: string): UserRecord | null {
  const wanted = name.trim().toLowerCase();
  return users.find((user) => user.name.toLowerCase() === wanted) ?? null;
}

/** 有 GitHub 凭据时用户表放仓库，否则放本地 data/。 */
export function getUserRepository(): UserRepository {
  const client = getGithubClient();
  return client ? new GithubUserRepository(client) : new LocalUserRepository();
}

/**
 * 首次部署的引导账号：仓库里还没有用户表时，用 WIKI_BOOTSTRAP_PASSWORD 登录 admin，
 * 成功后把哈希写进用户表。口令本身不落仓库、不进日志。
 */
export function bootstrapAllowed(users: UserRecord[], name: string): boolean {
  return users.length === 0 && name.trim().toLowerCase() === "admin" && Boolean(process.env.WIKI_BOOTSTRAP_PASSWORD);
}

export async function makeUser(name: string, password: string, role: Role): Promise<UserRecord> {
  const hash = await hashPassword(password);
  const uid = `u-${Buffer.from(name.trim().toLowerCase()).toString("hex").slice(0, 12)}`;
  return { uid, name: name.trim(), role, ...hash };
}

export async function addUser(
  repo: UserRepository,
  name: string,
  password: string,
  role: Role,
): Promise<UserRecord> {
  const users = await repo.load();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("用户名不能为空");
  if (findUser(users, trimmed)) throw new Error(`用户 ${trimmed} 已存在`);
  const user = await makeUser(trimmed, password, role);
  await repo.save([...users, user], `chore(users): 新增 ${trimmed}（${role}）`);
  return user;
}
