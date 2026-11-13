import { promises as fs } from "node:fs";
import path from "node:path";
import { LocalFileStore } from "../src/lib/storage";

const root = path.resolve(process.cwd(), "data");
const store = new LocalFileStore(root);

const indexMarkdown = `# 欢迎来到共创 Wiki

这是一个 **多人共创** 的示例页面，用来验证 M1 的读写链路。

## 本站怎么用

1. 打开任意页面，点右上角「编辑」。
2. 直接在富文本里改，不用写 Markdown，也不用 GitHub 账号。
3. 点「保存」，刷新阅读页即可看到新版。

> 内容存 GitHub，读者免登录；共创者只需要密码。

### 格式清单

- 粗体、*斜体*、~~删除线~~
- 站内指南：[快速上手](/w/guide.start)
- 表格、代码块、引用、图片

| 角色 | 能做什么 | 说明 |
| --- | --- | --- |
| 读者 viewer | 阅读 | 免登录 |
| 编辑者 editor | 编辑保存 | 邀请码加入 |
| 管理员 admin | 编辑 + 用户管理 | 站点维护 |

\`\`\`ts
const greeting: string = "你好，Wiki";
console.log(greeting);
\`\`\`

![示意图](/seed.svg)
`;

const guideMarkdown = `# 快速上手

给第一次参与共创的同事看的 **三分钟指南**。

## 1. 找到要改的页面

在首页列表里点标题，或直接用站内搜索（M2 接 Pagefind）。

## 2. 直接改

- 工具栏支持标题、粗体、斜体、列表、表格、代码块、引用、链接、图片
- 图片会自动压成 WebP，单张不超过 800KB
- 粘贴内容时不要带整页 HTML，编辑器只保留可用格式

## 3. 保存与冲突

保存成功后阅读页最多 15 秒可见新版。若提示冲突，说明别人先保存了，刷新后再改。

> 版本历史：每次保存都会留一条记录，M2 支持一键还原。

\`\`\`bash
npm run dev      # 本地启动
npm run build    # 构建检查
npm run test:store
\`\`\`
`;

const aboutMarkdown = `# 关于这个站

- 唯一可信源：GitHub 仓库里的 \`content/\` 目录
- 部署：腾讯 EdgeOne Makers（M2 接）
- 读者：免登录；共创者：邀请码 + 自设密码
- 图片：仓库 \`public/uploads/\`，不把 Blob 当图床
`;

async function main() {
  // 只在没有页面时播种，避免覆盖本地修改。
  const existing = await store.listPages();
  if (existing.length > 0) {
    console.log(`data 已有 ${existing.length} 页，跳过播种。`);
    return;
  }

  const pages = [
    { path: "content/index.md", title: "欢迎来到共创 Wiki", markdown: indexMarkdown },
    { path: "content/guide/start.md", title: "快速上手", markdown: guideMarkdown },
    { path: "content/about.md", title: "关于这个站", markdown: aboutMarkdown },
  ];

  for (const page of pages) {
    const result = await store.savePage({
      ...page,
      baseSha: null,
      images: [],
      actor: { uid: "u-admin", name: "管理员", role: "admin" },
    });
    if (!result.ok) throw new Error(`播种失败：${page.path} → ${result.message}`);
    console.log(`✓ ${page.path} (${result.sha.slice(0, 7)})`);
  }

  await fs.mkdir(path.join(root, "uploads"), { recursive: true });
  console.log("播种完成。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
