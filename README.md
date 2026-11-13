# 共创 Wiki · M1 本地骨架

多人共创 Wiki 的第一阶段（M1）实现：Astro 5 骨架 + TipTap 富文本编辑器 + Markdown 往返 + 本地文件存储 + 保存接口 + SSR 读路径。

**M1 边界**：不接 GitHub、不接 EdgeOne Blob、不部署、不注册账号、不写真实鉴权。存储层按 v2 §3.1 契约抽象，M2 只替换实现。

---

## 环境

- Node.js **≥ 22**（实测 v24.20.0）
- npm 11.19.0

## 安装与启动

```bash
cd /Users/fuheng/OpenBot/Shared/wiki-site
npm install          # 首次安装
npm run seed         # 首次播种 3 篇示例页（已有页面时自动跳过）
npm run dev          # http://localhost:4321
npm run build        # 构建检查（本次实测通过）
npm run test:store   # 存储层：写→读→列表→历史→冲突→权限→图片→还原
npm run test:md      # TipTap 中文页 md 往返 + 渲染安全
npm run test:images  # 图片读取双后端：public 302 / private not_implemented
```

## 实际安装版本（全部锁死，无 `^`）

| 包 | 版本 | 说明 |
|---|---|---|
| `astro` | 5.18.2 | 按 v2 要求锁 Astro 5.x（npm 最新为 7.4.11，未采用） |
| `@edgeone/astro` | 1.1.5 | 适配器就位，M1 不做真实部署 |
| `@astrojs/react` | 4.4.2 | React 岛 |
| `@astrojs/tailwind` | 6.0.2 | Tailwind 集成 |
| `tailwindcss` | 3.4.19 | 样式 |
| `react` / `react-dom` | 18.3.1 | Editor 岛运行时 |
| `@tiptap/core` / `pm` / `react` / `starter-kit` / `markdown` / `extension-table` / `extension-image` / `extension-placeholder` | 3.33.1 | 编辑器全套 |
| `markdown-it` | 14.1.0 | 读路径渲染，`html:false` |
| `lowlight` | 3.3.0 | 代码高亮 |
| `hast-util-to-html` | 9.0.6 | lowlight hast → HTML |
| `tsx` | 4.23.15 | 跑 TS 自测脚本 |
| `jsdom` | 27.4.0 | Node 里跑 TipTap 往返测试 |

## 页面与接口

| 路由 | 作用 |
|---|---|
| `/` | 页面列表 |
| `/w/<slug>` | SSR 阅读页；`slug` 由 `content/` 相对路径生成（`guide/start.md` → `guide.start`） |
| `/edit?path=content/...` | 富文本编辑页；路径不存在则进入新建模式 |
| `POST /api/save` | 保存：`{ path, title, markdown, baseSha, images[] }` |
| `GET /api/page?path=` 或 `?id=` | 读取单页（含 markdown 与 sha） |
| `GET /uploads/<pageId>/<file>` | 本地图片读路径（M1 本地存储） |
| `GET /img/<path>` | 仓库图片读取：`IMAGE_MODE=public` 302 到 raw；`private` 返回 501 `not_implemented` |

读路径响应头：`Cache-Control: public, s-maxage=10, stale-while-revalidate=60`、`ETag: "<sha>"`，支持 `If-None-Match` 返回 304。

## 图片读取配置

```bash
IMAGE_MODE=public        # public（默认）| private
GITHUB_REPO=owner/repo   # public 模式拼 raw 地址；M1 不会真的请求
GITHUB_BRANCH=main
```

- `public`：`/img/public/uploads/a.webp` → `302 https://raw.githubusercontent.com/<owner>/<repo>/<branch>/public/uploads/a.webp`，带 `Cache-Control: public, s-maxage=86400`。
- `private`：M1 明确返回 `501 {"code":"not_implemented"}`，**不会静默降级为 public**；M2 补只读 token 的 Node 代理。
- 缺 `GITHUB_REPO` 返回 500 `not_configured`；路径穿越返回 400 `invalid_path`；非法 `IMAGE_MODE` 返回 500 `invalid_mode`。

## 数据目录（`./data/`，已加入 .gitignore）

```
data/
├── content/                 # 正文 markdown（GitHub 仓库 content/ 的本地替身）
│   ├── index.md
│   ├── about.md
│   └── guide/start.md
├── meta.json                # 页面索引：id / path / title / sha / acl / order / parent
├── history/<pageId>.json    # 每次保存的完整快照（最新在前）
└── uploads/<pageId>/        # 随正文提交的图片
```

`WIKI_DATA_DIR` 可改根目录。`id = sha1(仓库相对路径)[:12]`；本地 `sha = sha1(markdown)`（M2 换成 GitHub blob sha）。

## Mock 身份（M1 专用）

页面右上角切换，写 Cookie `mock_role`：

- 管理员 admin：可编辑
- 编辑者 editor：可编辑（默认）
- 读者 viewer：只读，接口返回 403 `forbidden`

ACL 默认 `["admin","editor"]`；M2 接真实邀请码 / PBKDF2 / JWT（模块 F）后删除 `src/lib/session.ts` 的 mock 部分。

## M1 完成度对照（v2 §3.1）

| 模块 | 状态 | 实测证据 |
|---|---|---|
| A 脚手架 | 完成 | `npm run build` 零错误；dev 首页 200；`.env.example` 含 `IMAGE_MODE=public`；版本见上表 |
| B 存储抽象 | 完成 | `npm run test:store` 18 项全过；工厂 `getStore()` 单点切换 |
| C 编辑器 | 完成 | `npm run test:md` 中文页往返保留标题/粗斜体/列表/表格/代码块/引用/链接/图片，且二次往返幂等；浏览器实测插图、保存 |
| D 保存接口 | 完成 | editor 200 回新 sha；viewer 403；过期 `baseSha` 409；错误路径 400 |
| E 读路径 | 完成 | 响应头含 Cache-Control / ETag，ETag 命中 304；保存后刷新即见新版；`IMAGE_MODE=public` 实测 302 到 raw，`private` 实测 501 `not_implemented` |

**IMAGE_MODE 单列结果**：`public` 分支完整可用（302 + 长缓存，路径穿越拒绝）；`private` 保留类型、配置与路由分支，调用时明确抛 `not_implemented`，未降级；M1 不接真实 GitHub，`GITHUB_REPO` 仅用于拼 raw 地址。

## 已知问题 / M2 待办

1. **TipTap 序列化会补齐表格空白、合并空行**：内容无损，打开时的 diff 弹窗已忽略纯空白差异；只有真实格式丢失才弹原文对照。
2. **版本还原只有存储层能力**：`ContentStore.restore()` 已实现并被自测覆盖，`/api/restore` 与 UI 留在 M2 模块 J。
3. **首页是 SSR**（未 prerender），保证本地保存后立即在列表看到新页；M2 可改预渲染 + 构建触发。
4. **编辑器 chunk 546 KB**（gzip 174 KB），构建有体积提示，非错误；M2 可按需拆包。
5. **U3（Blob SDK 在 Astro/Node 运行时可用性）未实测**：M1 无 EdgeOne 账号与 Blob 凭据，只确认 `@edgeone/astro` 构建可过；M2 起手做最小 probe。
6. **U1/U2/U4**（免费额度、按 URL 刷缓存 API、备案周期）需控制台/文档核实，M1 不承诺。
7. **图片 private 分支未实现**：按约定只留类型、配置与 501 响应，M2 接 GitHub 只读 token 后补代理；仓库转私有时不能只改 `IMAGE_MODE`，还需补该分支。
8. M1 未做：真实鉴权、GitHub 单 commit、Blob 镜像、图片入库、部署、账号。

## 安全边界

- 读路径 `markdown-it({ html:false })`：正文中的 HTML 当文本转义，不执行；自测覆盖 `<script>` 与 `onerror`。
- 保存接口校验：必填字段、baseSha 类型、图片 MIME 白名单、单图 ≤800KB、路径不得穿越。
- `/uploads` 读接口限制在 `data/uploads/` 内，拒绝 `..`。

## 目录结构

```
wiki-site/
├── astro.config.mjs
├── tailwind.config.mjs
├── tsconfig.json
├── package.json
├── .env.example
├── public/seed.svg
├── scripts/
│   ├── seed.ts
│   ├── test-store.ts
│   ├── test-md.ts
│   └── test-images.ts
├── src/
│   ├── components/editor/
│   │   ├── Editor.tsx
│   │   ├── Toolbar.tsx
│   │   └── MdDiffDialog.tsx
│   ├── layouts/Base.astro
│   ├── lib/
│   │   ├── ids.ts
│   │   ├── images.ts
│   │   ├── render.ts
│   │   ├── session.ts
│   │   └── storage.ts
│   ├── pages/
│   │   ├── api/{save,page}.ts
│   │   ├── img/[...path].ts
│   │   ├── uploads/[...path].ts
│   │   ├── w/[slug].astro
│   │   ├── edit.astro
│   │   └── index.astro
│   └── styles/global.css
└── data/                    # 运行后生成（seed 播种）
```
