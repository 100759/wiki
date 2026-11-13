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

## 线上部署（EdgeOne Makers）

```bash
edgeone makers deploy -n wiki -t $EDGEONE_API_TOKEN --site china
```

- `--site china`：hchina 站、global 区域（按丞相首次部署口径记录）。
- API Token 只在执行部署的本机环境变量里，**不写进仓库、不打印**。
- 首次部署暴露的读路径问题已修：EdgeOne 运行时的 `/var/user` 不可写，`localFileStore` 现会降级为只读并用构建期打包的 `content/` 渲染；保存接口返回可读失败原因，不再 500。
- 部署后自测探针：`curl https://<域名>/api/_probe`（见下节）。

## 只读部署兜底与打包内容

- 数据目录（默认 `./data`，或 `WIKI_DATA_DIR`）**不可写时**：不抛错，自动进入只读模式；`listPages()` 返回空列表、`getPageByPath()` 返回 null、`savePage()` 返回 `{ ok:false, code:"invalid" }`，页面路由正常渲染 404/首页。
- 仓库根目录新增 `content/`（`index.md`、`about.md`、`guide/start.md`），构建时由 `import.meta.glob` 以 `?raw` 打进服务端产物；线上首屏优先读这份快照。磁盘 `data/content` 存在同路径时以磁盘为准。
- 本地复现只读部署：把 `WIKI_DATA_DIR` 指到不可写目录（如 `chmod 0555` 的临时目录）后启动，首页与 `/w/index` 仍应 200。
- `/api/_probe`：U3 实测，JSON 返回三步结果——能否 import `@edgeone/pages-blob`、能否 `getStore("wiki-probe")`、能否写读一个键（strong）。只返回能力结果，不读不打印凭据。本地非 Pages 运行时通常 import 通过、store 失败（`Missing: deployCredential`），属预期；以线上结果为准。注意 Astro 不把以 `_` 开头的页面文件当路由，实际处理器在 `src/pages/api/[...path].ts`，逻辑在 `src/lib/probe.ts`。

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
| `@edgeone/pages-blob` | 0.0.19 | U3 探针用；仅 `/api/_probe` 动态导入 |
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
| `GET /api/_probe` | U3 探针：import Blob SDK、getStore、写读一个键，JSON 返回 |

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
| B 存储抽象 | 完成 | `npm run test:store` 22 项全过（新增只读兜底 4 项）；工厂 `getStore()` 单点切换 |
| C 编辑器 | 完成 | `npm run test:md` 中文页往返保留标题/粗斜体/列表/表格/代码块/引用/链接/图片，且二次往返幂等；浏览器实测插图、保存 |
| D 保存接口 | 完成 | editor 200 回新 sha；viewer 403；过期 `baseSha` 409；错误路径 400 |
| E 读路径 | 完成 | 响应头含 Cache-Control / ETag，ETag 命中 304；保存后刷新即见新版；`IMAGE_MODE=public` 实测 302 到 raw，`private` 实测 501 `not_implemented` |

**IMAGE_MODE 单列结果**：`public` 分支完整可用（302 + 长缓存，路径穿越拒绝）；`private` 保留类型、配置与路由分支，调用时明确抛 `not_implemented`，未降级；M1 不接真实 GitHub，`GITHUB_REPO` 仅用于拼 raw 地址。

## 首次线上部署暴露的落地缺口（已修）

| # | 问题 | 处理 | 状态 |
|---|---|---|---|
| H1 | EdgeOne `/var/user` 只读，`localFileStore` 建 `./data` 抛 ENOENT，所有路由 500 | `ensureDirs()` 探测失败即降级只读；读返回空/打包内容，写返回 `invalid`，全程不抛错 | 完成，本地只读模拟通过 |
| H2 | 仓库无 `content/` 种子，新部署空站 | 新增仓库根 `content/`，`import.meta.glob(?raw)` 构建期打包；线上首屏读快照，磁盘同路径优先 | 完成 |
| H3 | U3：Blob SDK 在 Astro/Node 运行时是否可用 | 新增 `GET /api/_probe`，三步 JSON：import → getStore → 写读一个键（strong） | 代码完成，待线上跑 |

## 已知问题 / M2 待办

1. **TipTap 序列化会补齐表格空白、合并空行**：内容无损，打开时的 diff 弹窗已忽略纯空白差异；只有真实格式丢失才弹原文对照。
2. **版本还原只有存储层能力**：`ContentStore.restore()` 已实现并被自测覆盖，`/api/restore` 与 UI 留在 M2 模块 J。
3. **首页是 SSR**（未 prerender），保证本地保存后立即在列表看到新页；M2 可改预渲染 + 构建触发。
4. **编辑器 chunk 546 KB**（gzip 174 KB），构建有体积提示，非错误；M2 可按需拆包。
5. **U3（Blob SDK 运行时）**：`/api/_probe` 已就位，本地非 Pages 运行时 import 通过但 `getStore` 会失败（预期）；线上结果出来前不承诺 Blob 镜像方案，跑不通按预案改 Cloud Functions 代理。
6. **U1/U2/U4**（免费额度、按 URL 刷缓存 API、备案周期）需控制台/文档核实，M1 不承诺。
7. **图片 private 分支未实现**：按约定只留类型、配置与 501 响应，M2 接 GitHub 只读 token 后补代理；仓库转私有时不能只改 `IMAGE_MODE`，还需补该分支。
8. **`/uploads` 是 M1 本地过渡路由**：M2 图片读路径统一迁到 `/img/` 后删除；该路由已去掉 `.svg` 映射，白名单外文件按附件下载并带 `nosniff` + CSP `sandbox`。
9. **M2 模块 G 并发**：按 v2 §2.7 在 `savePage` 内部处理 422 重试（重取 ref → 新 head 作 base_tree → 只覆盖本次 path → 最多 3 次；比对目标 blob sha 决定成功或 conflict），M1 仅在代码注释中标注，未提前实现。
10. **线上只读模式不能保存**：M2 接 Blob/GitHub 前，线上编辑保存会返回 `invalid`（README 已说明）；阅读正常。
11. M1 工部未执行部署、未接真实 GitHub/Blob、未注册账号；线上首部署由丞相用 CLI 完成。

## 安全边界

- 读路径 `markdown-it({ html:false })`：正文中的 HTML 当文本转义，不执行；自测覆盖 `<script>` 与 `onerror`。
- 保存接口校验：必填字段、baseSha 类型、图片 MIME 白名单、单图 ≤800KB、路径不得穿越。
- `/uploads` 读接口限制在 `data/uploads/` 内，拒绝 `..`；只按位图 MIME 返回，`.svg` 等白名单外文件强制 `Content-Disposition: attachment`，并统一加 `X-Content-Type-Options: nosniff` 与 `Content-Security-Policy: default-src 'none'; sandbox`。

## 目录结构

```
wiki-site/
├── astro.config.mjs
├── tailwind.config.mjs
├── tsconfig.json
├── package.json
├── .env.example
├── public/seed.svg
├── content/                 # 仓库唯一可信源的种子（构建期打包进产物）
│   ├── index.md
│   ├── about.md
│   └── guide/start.md
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
│   │   ├── bundled.ts
│   │   ├── ids.ts
│   │   ├── images.ts
│   │   ├── probe.ts
│   │   ├── render.ts
│   │   ├── session.ts
│   │   └── storage.ts
│   ├── pages/
│   │   ├── api/{save,page}.ts
│   │   ├── api/[...path].ts   # 提供 /api/_probe（Astro 不把 `_` 开头文件当路由）
│   │   ├── img/[...path].ts
│   │   ├── uploads/[...path].ts
│   │   ├── w/[slug].astro
│   │   ├── edit.astro
│   │   └── index.astro
│   └── styles/global.css
└── data/                    # 运行后生成（seed 播种）
```
