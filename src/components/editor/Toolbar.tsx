import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";

interface Props {
  editor: Editor | null;
  disabled: boolean;
  onPickImage: () => void;
}

function Btn({
  onClick,
  active,
  disabled,
  label,
  title,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className={
        "rounded px-2 py-1 text-sm leading-5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 " +
        (active ? "bg-ink text-white" : "text-stone-700 hover:bg-stone-200")
      }
    >
      {label}
    </button>
  );
}

export default function Toolbar({ editor, disabled, onPickImage }: Props) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive("bold") ?? false,
      italic: e?.isActive("italic") ?? false,
      strike: e?.isActive("strike") ?? false,
      h1: e?.isActive("heading", { level: 1 }) ?? false,
      h2: e?.isActive("heading", { level: 2 }) ?? false,
      h3: e?.isActive("heading", { level: 3 }) ?? false,
      bullet: e?.isActive("bulletList") ?? false,
      ordered: e?.isActive("orderedList") ?? false,
      quote: e?.isActive("blockquote") ?? false,
      code: e?.isActive("codeBlock") ?? false,
      link: e?.isActive("link") ?? false,
      canUndo: e?.can().undo() ?? false,
      canRedo: e?.can().redo() ?? false,
    }),
  });

  if (!editor) {
    return <div className="h-11 rounded-t-lg border-b border-stone-200 bg-stone-50" />;
  }

  const chain = () => editor.chain().focus();

  const setLink = () => {
    const previous = (editor.getAttributes("link").href as string | undefined) ?? "";
    const url = window.prompt("链接地址（留空则移除链接）", previous || "https://");
    if (url === null) return;
    if (!url.trim()) {
      chain().extendMarkRange("link").unsetLink().run();
      return;
    }
    chain().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-t-lg border-b border-stone-200 bg-stone-50 px-2 py-1.5">
      <Btn label="H1" active={state.h1} disabled={disabled} onClick={() => chain().toggleHeading({ level: 1 }).run()} />
      <Btn label="H2" active={state.h2} disabled={disabled} onClick={() => chain().toggleHeading({ level: 2 }).run()} />
      <Btn label="H3" active={state.h3} disabled={disabled} onClick={() => chain().toggleHeading({ level: 3 }).run()} />
      <span className="mx-1 h-5 w-px bg-stone-300" />
      <Btn label="B" title="加粗" active={state.bold} disabled={disabled} onClick={() => chain().toggleBold().run()} />
      <Btn label="I" title="斜体" active={state.italic} disabled={disabled} onClick={() => chain().toggleItalic().run()} />
      <Btn label="S" title="删除线" active={state.strike} disabled={disabled} onClick={() => chain().toggleStrike().run()} />
      <span className="mx-1 h-5 w-px bg-stone-300" />
      <Btn label="• 列表" active={state.bullet} disabled={disabled} onClick={() => chain().toggleBulletList().run()} />
      <Btn label="1. 列表" active={state.ordered} disabled={disabled} onClick={() => chain().toggleOrderedList().run()} />
      <Btn label="引用" active={state.quote} disabled={disabled} onClick={() => chain().toggleBlockquote().run()} />
      <Btn label="代码块" active={state.code} disabled={disabled} onClick={() => chain().toggleCodeBlock().run()} />
      <span className="mx-1 h-5 w-px bg-stone-300" />
      <Btn
        label="表格"
        disabled={disabled}
        onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      />
      <Btn label="链接" active={state.link} disabled={disabled} onClick={setLink} />
      <Btn label="图片" disabled={disabled} onClick={onPickImage} />
      <Btn label="分隔线" disabled={disabled} onClick={() => chain().setHorizontalRule().run()} />
      <span className="ml-auto flex items-center gap-0.5">
        <Btn label="撤销" disabled={disabled || !state.canUndo} onClick={() => chain().undo().run()} />
        <Btn label="重做" disabled={disabled || !state.canRedo} onClick={() => chain().redo().run()} />
      </span>
    </div>
  );
}
