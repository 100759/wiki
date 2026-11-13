import { promises as fs } from "node:fs";
import path from "node:path";
import { LocalFileStore } from "../src/lib/storage";
import { pageId } from "../src/lib/ids";

const root = path.resolve(process.cwd(), ".tmp/test-store");
let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const editor = { uid: "u-editor", name: "编辑者", role: "editor" as const };
const viewer = { uid: "u-viewer", name: "读者", role: "viewer" as const };
const admin = { uid: "u-admin", name: "管理员", role: "admin" as const };

async function main() {
  await fs.rm(root, { recursive: true, force: true });
  const store = new LocalFileStore(root);

  const v1 = "# 第一版\n\n你好，世界。\n";
  const created = await store.savePage({
    path: "content/guide/start.md",
    title: "快速上手",
    markdown: v1,
    baseSha: null,
    images: [],
    actor: editor,
  });
  check("写页成功", created.ok, JSON.stringify(created));
  if (!created.ok) throw new Error("首次写入失败");

  const read = await store.getPageByPath("content/guide/start.md");
  check("读回内容一致", read?.markdown === v1);
  check("读回 sha 与保存返回一致", read?.sha === created.sha);
  check("id = sha1(path)[:12]", read?.id === pageId("content/guide/start.md"), read?.id);
  check("路径归一化（缺 content/ 与 .md 也能读）", (await store.getPageByPath("guide/start"))?.id === read?.id);

  const listed = await store.listPages();
  check("列表包含刚写的页", listed.length === 1 && listed[0]?.path === "content/guide/start.md");

  const history1 = await store.listHistory("content/guide/start.md", 10);
  check("历史有 1 条", history1.length === 1, String(history1.length));

  const stale = await store.savePage({
    path: "content/guide/start.md",
    title: "快速上手",
    markdown: v1 + "\n被别人抢先保存\n",
    baseSha: null, // 过期基线
    images: [],
    actor: editor,
  });
  check("baseSha 不匹配 → conflict", !stale.ok && stale.code === "conflict");

  const v2 = v1 + "\n第二版新增一段。\n";
  const updated = await store.savePage({
    path: "content/guide/start.md",
    title: "快速上手",
    markdown: v2,
    baseSha: created.sha,
    images: [],
    actor: editor,
  });
  check("带正确 baseSha 保存成功", updated.ok, JSON.stringify(updated));

  const forbidden = await store.savePage({
    path: "content/guide/start.md",
    title: "快速上手",
    markdown: "篡改",
    baseSha: updated.ok ? updated.sha : null,
    images: [],
    actor: viewer,
  });
  check("viewer 保存 → forbidden", !forbidden.ok && forbidden.code === "forbidden");

  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const v3 = `${v2}\n![图](/uploads/pending/pic.png)\n`;
  const withImage = await store.savePage({
    path: "content/guide/start.md",
    title: "快速上手",
    markdown: v3,
    baseSha: updated.ok ? updated.sha : null,
    images: [{ name: "pic.png", bytes: png, mime: "image/png" }],
    actor: editor,
  });
  check("带图片保存成功", withImage.ok, JSON.stringify(withImage));
  const afterImage = await store.getPageByPath("content/guide/start.md");
  check(
    "pending 图片路径被改写为正式路径",
    (afterImage?.markdown ?? "").includes(`/uploads/${afterImage?.id}/pic.png`),
    afterImage?.markdown,
  );
  const stored = await fs.readFile(path.join(root, "uploads", afterImage?.id ?? "", "pic.png"));
  check("图片二进制落盘", stored.byteLength === png.byteLength);

  const history3 = await store.listHistory("content/guide/start.md", 10);
  check("历史累计 3 条且最新在前", history3.length === 3 && withImage.ok && history3[0]?.sha === withImage.sha);

  const back = await store.restore("content/guide/start.md", created.sha, {
    uid: "u-test",
    name: "测试编辑",
    role: "editor",
  });
  check("还原到第一版成功", back.ok, JSON.stringify(back));
  const restored = await store.getPageByPath("content/guide/start.md");
  check("还原后内容回到第一版", restored?.markdown === v1);
  check("还原也记一条历史", (await store.listHistory("content/guide/start.md", 10)).length === 4);

  const bad = await store.savePage({
    path: "content/../etc/passwd",
    title: "x",
    markdown: "x",
    baseSha: null,
    images: [],
    actor: editor,
  });
  check("路径穿越被拒绝", !bad.ok && bad.code === "invalid");

  // 只读兜底：数据目录不可写时，读返回空、写返回失败，但都不抛错。
  const roParent = path.join(root, "readonly");
  await fs.mkdir(roParent, { recursive: true });
  await fs.chmod(roParent, 0o555);
  const roStore = new LocalFileStore(path.join(roParent, "data"));
  let roThrew = false;
  try {
    const roPages = await roStore.listPages();
    const roPage = await roStore.getPageByPath("content/index.md");
    const roSave = await roStore.savePage({
      path: "content/ro.md",
      title: "只读",
      markdown: "只读",
      baseSha: null,
      images: [],
      actor: admin,
    });
    check("只读模式列表为空但不抛错", Array.isArray(roPages) && roPages.length === 0);
    check("只读模式读页返回 null", roPage === null);
    check("只读模式保存返回 invalid 而非抛错", !roSave.ok && roSave.code === "invalid", JSON.stringify(roSave));
  } catch (err) {
    roThrew = true;
    console.error(err);
  }
  check("只读模式全程无异常", !roThrew);
  await fs.chmod(roParent, 0o755);

  await fs.rm(root, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} 项失败`);
    process.exit(1);
  }
  console.log("\n全部通过。");
}

main().catch(async (err) => {
  console.error(err);
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
