interface Props {
  original: string;
  converted: string;
  onAcceptConverted: () => void;
  onUseOriginal: () => void;
}

interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** 简易行级 diff（LCS）；M1 文本量小，够用。 */
function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

export default function MdDiffDialog({ original, converted, onAcceptConverted, onUseOriginal }: Props) {
  const lines = diffLines(original.split("\n"), converted.split("\n"));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="border-b border-stone-200 px-4 py-3">
          <h2 className="text-base font-semibold">Markdown 往返存在差异</h2>
          <p className="mt-1 text-xs text-stone-500">
            这篇页面经“Markdown → 富文本 → Markdown”转换后有格式差异。请确认用哪种内容继续编辑：
            <span className="ml-1 text-red-600">- 原文</span> /
            <span className="ml-1 text-green-700">+ 转换后</span>。
          </p>
        </div>
        <pre className="max-h-[55vh] overflow-auto bg-stone-50 px-4 py-3 text-xs leading-5">
          {lines.map((line, idx) => (
            <div
              key={idx}
              className={
                line.kind === "add"
                  ? "bg-green-50 text-green-800"
                  : line.kind === "del"
                    ? "bg-red-50 text-red-800"
                    : "text-stone-600"
              }
            >
              <span className="mr-2 inline-block w-3 select-none text-stone-400">
                {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
              </span>
              {line.text || "\u00a0"}
            </div>
          ))}
        </pre>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 px-4 py-3">
          <button
            type="button"
            onClick={onUseOriginal}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
          >
            用原文覆盖编辑器
          </button>
          <button
            type="button"
            onClick={onAcceptConverted}
            className="rounded-md bg-ink px-3 py-1.5 text-sm text-white hover:bg-black"
          >
            用转换结果继续
          </button>
        </div>
      </div>
    </div>
  );
}
