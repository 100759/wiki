import { JSDOM } from "jsdom";

/**
 * C 验收：markdown → 编辑器 → markdown 往返。
 * 用 jsdom 在 Node 里跑 TipTap，不依赖浏览器。
 */

const sample = `# 中文页面 · 往返测试

这是一段包含 **加粗**、*斜体*、~~删除线~~ 和 [链接](https://example.com) 的正文。

## 列表

- 第一项
- 第二项
  - 嵌套项

1. 有序一
2. 有序二

## 表格

| 角色 | 权限 |
| --- | --- |
| 管理员 | 全部 |
| 编辑者 | 编辑 |

## 代码与引用

> 引用一段话，里面也有 **加粗**。

\`\`\`ts
const answer: number = 42;
console.log(answer);
\`\`\`

![示意图](/seed.svg)
`;

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? `\n--- 实际 ---\n${detail}` : ""}`);
  }
}

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const { window } = dom;
  const g = globalThis as Record<string, unknown>;
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });

  define("window", window);
  define("document", window.document);
  define("navigator", window.navigator);
  define("HTMLElement", window.HTMLElement);
  define("Node", window.Node);
  define("Element", window.Element);
  define("DOMParser", window.DOMParser);
  define("MutationObserver", window.MutationObserver);
  define("getSelection", window.getSelection.bind(window));
  define("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0));
  define("cancelAnimationFrame", (id: number) => clearTimeout(id));
  void g;

  const { Editor } = await import("@tiptap/core");
  const { StarterKit } = await import("@tiptap/starter-kit");
  const { Markdown } = await import("@tiptap/markdown");
  const { TableKit } = await import("@tiptap/extension-table");
  const { Image } = await import("@tiptap/extension-image");

  const element = window.document.createElement("div");
  window.document.body.appendChild(element);

  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Markdown.configure({ indentation: { style: "space", size: 2 } }),
      TableKit.configure({ table: { resizable: false } }),
      Image.configure({ inline: false, allowBase64: false }),
    ],
    content: sample,
    contentType: "markdown",
  });

  const out = editor.getMarkdown();
  console.log("--- 往返结果 ---\n" + out + "\n----------------");

  const mustKeep = [
    "# 中文页面 · 往返测试",
    "**加粗**",
    "*斜体*",
    "~~删除线~~",
    "[链接](https://example.com)",
    "- 第一项",
    "1. 有序一",
    "|角色|权限|",
    "|管理员|全部|",
    "> 引用一段话",
    "```ts",
    "const answer: number = 42;",
    "![示意图](/seed.svg)",
    "嵌套项",
  ];

  // 表格只允许空白补齐差异，内容与结构必须保留。
  const compact = out.replace(/\|/g, "|").replace(/[ \t]+/g, " ").replace(/\s*\|\s*/g, "|");

  for (const needle of mustKeep) {
    check(`保留：${needle}`, (needle.startsWith("|") ? compact : out).includes(needle));
  }

  check("再次往返稳定（幂等）", (() => {
    const second = new Editor({
      element: window.document.createElement("div"),
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
        Markdown.configure({ indentation: { style: "space", size: 2 } }),
        TableKit.configure({ table: { resizable: false } }),
        Image.configure({ inline: false, allowBase64: false }),
      ],
      content: out,
      contentType: "markdown",
    });
    const secondOut = second.getMarkdown();
    second.destroy();
    return secondOut === out;
  })());

  // 安全：html:false 的渲染不得输出可执行标签。
  const { renderMarkdown } = await import("../src/lib/render");
  const rendered = renderMarkdown('你好 <script>alert("x")</script>\n\n<img src=x onerror=alert(1)>');
  check("渲染器转义 <script>", !rendered.includes("<script>"), rendered);
  check("渲染器转义 onerror", !rendered.includes("<img src=x"), rendered);

  const codeHtml = renderMarkdown("\`\`\`ts\nconst a: number = 1;\n\`\`\`");
  check("代码块高亮正常（不是 undefined）", codeHtml.includes("hljs-keyword") && !codeHtml.includes("undefined"), codeHtml);

  editor.destroy();
  dom.window.close();

  if (failures > 0) {
    console.error(`\n${failures} 项失败`);
    process.exit(1);
  }
  console.log("\n全部通过。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
