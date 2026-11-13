import { promises as fs } from "node:fs";
import path from "node:path";
import { LocalFileStore } from "../src/lib/storage";

const root = path.resolve(process.cwd(), "data");
const contentRoot = path.resolve(process.cwd(), "content");
const store = new LocalFileStore(root);

async function collectMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectMarkdown(full)));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out.sort();
}

async function main() {
  // data 已有索引就视为已初始化，避免覆盖本地修改。
  try {
    await fs.access(path.join(root, "meta.json"));
    console.log("data/meta.json 已存在，跳过播种。");
    return;
  } catch {
    /* 首次运行 */
  }

  const files = await collectMarkdown(contentRoot);
  if (files.length === 0) {
    console.log("content/ 下没有 markdown，跳过播种。");
    return;
  }

  for (const file of files) {
    const rel = path.relative(contentRoot, file).split(path.sep).join("/");
    const contentPath = `content/${rel}`;
    const markdown = await fs.readFile(file, "utf8");
    const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? rel.replace(/\.md$/, "");
    const result = await store.savePage({
      path: contentPath,
      title,
      markdown,
      baseSha: null,
      images: [],
      actor: { uid: "u-admin", name: "管理员", role: "admin" },
    });
    if (!result.ok) throw new Error(`播种失败：${contentPath} → ${result.message}`);
    console.log(`✓ ${contentPath} (${result.sha.slice(0, 7)})`);
  }

  await fs.mkdir(path.join(root, "uploads"), { recursive: true });
  console.log("播种完成。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
