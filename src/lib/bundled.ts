export interface BundledPage {
  path: string;
  markdown: string;
}

/**
 * 构建期把仓库 content/ 打进服务端产物。
 * 线上只读环境（EdgeOne）首屏直接从这份快照读，写路径再走 Blob/GitHub。
 * 本地 tsx 自测里没有 Vite 的 import.meta.glob，调用方会捕获并退化为空。
 */
async function loadBundled(): Promise<BundledPage[]> {
  try {
    const modules = import.meta.glob("/content/**/*.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;

    return Object.entries(modules)
      .map(([file, markdown]) => ({
        path: file.replace(/^\/+/, ""),
        markdown,
      }))
      .filter((page) => page.path.startsWith("content/"))
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    return [];
  }
}

let cache: Promise<BundledPage[]> | null = null;

export function getBundledPages(): Promise<BundledPage[]> {
  if (!cache) cache = loadBundled();
  return cache;
}
