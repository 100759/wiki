import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { Image } from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extension-placeholder";
import Toolbar from "./Toolbar";
import MdDiffDialog from "./MdDiffDialog";

export interface PageData {
  id: string;
  path: string;
  title: string;
  markdown: string;
  sha: string;
  updatedAt: string;
  updatedBy: string;
  acl: string[];
  order: number;
  parent: string | null;
}

export interface SessionUser {
  uid: string;
  name: string;
  role: "admin" | "editor" | "viewer";
}

interface HistoryItem {
  sha: string;
  message: string;
  date: string;
  author: string;
}

interface UploadImage {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

interface Props {
  initial: PageData;
  user: SessionUser;
  history: HistoryItem[];
}

const MAX_BYTES = 800 * 1024;

function slugOf(contentPath: string): string {
  const rel = contentPath.replace(/^content\//, "").replace(/\.md$/, "");
  if (!rel || rel === "index") return "index";
  return rel.split("/").map((s) => encodeURIComponent(s)).join(".");
}

async function compressImage(file: File): Promise<UploadImage> {
  if (file.type === "image/gif") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw new Error("GIF 超过 800KB，请先压缩后再插入");
    return { name: file.name, mime: "image/gif", bytes };
  }

  const bitmap = await createImageBitmap(file);
  const maxWidth = 1600;
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持图片压缩");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  let quality = 0.9;
  let blob: Blob | null = null;
  do {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    if (!blob || blob.size <= MAX_BYTES) break;
    quality -= 0.1;
  } while (quality >= 0.4);

  if (!blob) throw new Error("图片编码失败");
  if (blob.size > MAX_BYTES) throw new Error("压缩后仍超过 800KB，请换一张小一点的图");
  const name = `${file.name.replace(/\.[^.]+$/, "") || "image"}.webp`;
  return {
    name,
    mime: "image/webp",
    bytes: new Uint8Array(await blob.arrayBuffer()),
  };
}

export default function Editor({ initial, user, history }: Props) {
  const [title, setTitle] = useState(initial.title);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [diff, setDiff] = useState<{ original: string; converted: string } | null>(null);
  const [pendingImages, setPendingImages] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const roundTripChecked = useRef(false);
  const readOnly = user.role === "viewer";

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true },
      }),
      Markdown.configure({ indentation: { style: "space", size: 2 } }),
      TableKit.configure({ table: { resizable: false } }),
      Image.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({ placeholder: "开始写……支持标题、列表、表格、代码块、引用、链接和图片" }),
    ],
    content: initial.markdown,
    contentType: "markdown",
    editable: !readOnly,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "wiki-prose px-4 py-4 focus:outline-none",
        spellcheck: "false",
      },
    },
    onUpdate: () => setDirty(true),
  });

  // C 验收：载入后做一次 md → 编辑器 → md 往返，有差异弹原文对照。
  useEffect(() => {
    if (!editor || roundTripChecked.current) return;
    roundTripChecked.current = true;
    const converted = editor.getMarkdown();
    // 纯空白/表格对齐差异不算信息丢失，避免每次打开都弹窗。
    const normalize = (text: string) =>
      text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => (line.trimStart().startsWith("|") ? line.trim().replace(/\s*\|\s*/g, "|").replace(/-{3,}/g, "---") : line.trimEnd()))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (normalize(initial.markdown) !== normalize(converted)) setDiff({ original: initial.markdown, converted });
  }, [editor, initial.markdown]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty && !saving) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, saving]);

  const onPickImage = useCallback(() => fileInputRef.current?.click(), []);

  const onFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (!editor || files.length === 0) return;
      setPendingImages((n) => n + files.length);
      for (const file of files) {
        try {
          const image = await compressImage(file);
          // 图片单独上传：原始二进制走 /api/upload，避免 base64 撑爆保存请求体（1MB 上限）。
          const response = await fetch(`/api/upload?path=${encodeURIComponent(initial.path)}`, {
            method: "POST",
            headers: {
              "content-type": image.mime,
              "x-file-name": encodeURIComponent(image.name),
            },
            body: image.bytes,
          });
          const payload = (await response.json()) as
            | { ok: true; url: string }
            | { ok: false; code: string; message: string };
          if (!response.ok || !payload.ok) {
            throw new Error(!payload.ok ? payload.message : `上传失败（HTTP ${response.status}）`);
          }
          editor
            .chain()
            .focus()
            .setImage({ src: payload.url, alt: image.name, title: image.name })
            .run();
          setStatus({ kind: "info", text: `已上传 ${image.name}` });
        } catch (err) {
          setStatus({ kind: "error", text: `图片上传失败：${(err as Error).message}` });
        } finally {
          setPendingImages((n) => Math.max(0, n - 1));
        }
      }
    },
    [editor, initial.path],
  );

  const save = useCallback(async () => {
    if (!editor || readOnly) return;
    setSaving(true);
    setStatus(null);

    let markdown = editor.getMarkdown();

    if (markdown.trim() === "") {
      setSaving(false);
      setStatus({ kind: "error", text: "正文为空，未保存" });
      return;
    }

    // 富文本里连续回车会留下只有 &nbsp; 的空段落，保存前清掉。
    markdown = markdown.replace(/^[ \t]*&nbsp;[ \t]*$/gm, "").replace(/\n{3,}/g, "\n\n");

    try {
      const response = await fetch("/api/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: initial.path,
          title: title.trim() || "未命名页面",
          markdown,
          baseSha: initial.sha || null,
        }),
      });
      const data = (await response.json()) as
        | { ok: true; sha: string; commit: string }
        | { ok: false; code: string; message: string };

      if (response.ok && data.ok) {
        setDirty(false);
        setStatus({ kind: "ok", text: "已保存，正在打开阅读页……" });
        window.location.assign(`/w/${slugOf(initial.path)}`);
        return;
      }

      if (!data.ok && data.code === "conflict") {
        setStatus({ kind: "error", text: "保存冲突：页面已被他人修改。请刷新后重试。" });
      } else if (!data.ok) {
        setStatus({ kind: "error", text: data.message || "保存失败" });
      } else {
        setStatus({ kind: "error", text: `保存失败（HTTP ${response.status}）` });
      }
    } catch (err) {
      setStatus({ kind: "error", text: `保存失败：${(err as Error).message}` });
    } finally {
      setSaving(false);
    }
  }, [editor, initial.path, initial.sha, readOnly, title]);

  const revertTo = useCallback(
    async (sha: string) => {
      if (!window.confirm("确定把这一页恢复到这个版本？这会生成一次新的提交，旧版本仍保留在历史里。")) {
        return;
      }
      setSaving(true);
      setStatus(null);
      try {
        const response = await fetch("/api/revert", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: initial.path, sha }),
        });
        const data = (await response.json()) as
          | { ok: true }
          | { ok: false; code: string; message: string };
        if (response.ok && data.ok) {
          window.location.reload();
          return;
        }
        setStatus({ kind: "error", text: !data.ok ? data.message : "还原失败" });
      } catch (err) {
        setStatus({ kind: "error", text: `还原失败：${(err as Error).message}` });
      } finally {
        setSaving(false);
      }
    },
    [initial.path],
  );

  const insertExternalLink = useCallback(() => {
    // 由 Toolbar 处理；保留占位以便后续扩展。
  }, []);
  void insertExternalLink;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <label className="label mb-1 block" htmlFor="page-title">
            页面标题
          </label>
          <input
            id="page-title"
            value={title}
            disabled={readOnly}
            onInput={(event) => {
              setTitle((event.target as HTMLInputElement).value);
              setDirty(true);
            }}
            className="w-full border-0 border-b border-hairline bg-transparent px-0 py-2 text-[1.9rem] font-light leading-tight tracking-tight text-ink outline-none focus:border-ink disabled:text-stone-400"
            placeholder="页面标题"
          />
          <div className="mt-1 truncate text-xs text-stone-400">
            <code>{initial.path}</code> · {initial.sha ? `sha ${initial.sha.slice(0, 7)}` : "新页面"}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <a
            href={`/w/${slugOf(initial.path)}`}
            className="border border-hairline px-3 py-1.5 text-[12px] uppercase tracking-label text-graphite transition-colors hover:border-ink hover:text-ink"
          >
            阅读页
          </a>
          <button
            type="button"
            onClick={save}
            disabled={saving || readOnly || pendingImages > 0}
            className="border border-ink bg-ink px-4 py-1.5 text-[12px] uppercase tracking-label text-paper transition-colors hover:bg-paper hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      {readOnly && (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          当前账号没有编辑权限（viewer），只能阅读。需要编辑请让管理员调整角色。
        </div>
      )}

      {status && (
        <div
          className={
            "mb-3 rounded-md border px-3 py-2 text-sm " +
            (status.kind === "error"
              ? "border-red-300 bg-red-50 text-red-800"
              : status.kind === "ok"
                ? "border-green-300 bg-green-50 text-green-800"
                : "border-stone-300 bg-stone-50 text-stone-700")
          }
        >
          {status.text}
        </div>
      )}

      <div className="tiptap-shell border border-hairline bg-white">
        <Toolbar editor={editor} disabled={readOnly} onPickImage={onPickImage} />
        <EditorContent editor={editor} />
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={onFileChange} />

      <section className="mt-10 border-t border-hairline pt-6">
        <h2 className="label mb-3 block">版本历史（最近 {history.length} 条）</h2>
        {history.length === 0 ? (
          <p className="text-xs text-stone-400">暂无保存记录。</p>
        ) : (
          <ul className="space-y-1 text-xs text-stone-500">
            {history.map((item) => (
              <li key={item.sha} className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-stone-100 px-1 py-0.5">{item.sha.slice(0, 7)}</code>
                <span className="text-stone-700">{item.message}</span>
                <span>· {item.author}</span>
                <span>· {new Date(item.date).toLocaleString("zh-CN")}</span>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => revertTo(item.sha)}
                  className="border border-hairline px-1.5 py-0.5 text-[11px] text-graphite transition-colors hover:border-ink hover:text-ink disabled:opacity-40"
                >
                  恢复此版本
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-stone-400">
          还原会生成一次新提交，旧版本仍然保留在历史里。
        </p>
      </section>

      {diff && (
        <MdDiffDialog
          original={diff.original}
          converted={diff.converted}
          onAcceptConverted={() => setDiff(null)}
          onUseOriginal={() => {
            editor?.commands.setContent(diff.original, { contentType: "markdown" });
            setDiff(null);
            setDirty(true);
          }}
        />
      )}
    </div>
  );
}
