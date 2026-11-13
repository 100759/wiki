export interface ProbeResult {
  runtime: string;
  at: string;
  import: { ok: boolean; exports?: string[]; error?: string };
  store: {
    ok: boolean;
    key?: string;
    strongRead?: boolean;
    matches?: boolean;
    readBack?: unknown;
    error?: string;
  };
}

/**
 * U3 实测探针：只做三件事——import SDK、getStore、写读一个键。
 * 只返回能力结果，不读取、不打印任何凭据或环境变量。
 */
export async function runProbe(): Promise<ProbeResult> {
  const result: ProbeResult = {
    runtime: `node ${process.version}`,
    at: new Date().toISOString(),
    import: { ok: false },
    store: { ok: false },
  };

  let mod: typeof import("@edgeone/pages-blob");
  try {
    mod = await import("@edgeone/pages-blob");
    result.import = { ok: true, exports: Object.keys(mod) };
  } catch (err) {
    result.import = { ok: false, error: (err as Error).message };
    return result;
  }

  try {
    if (typeof mod.getStore !== "function") {
      throw new Error("模块存在但缺少 getStore 导出");
    }
    const store = mod.getStore("wiki-probe");
    const key = `probe/${Date.now()}.json`;
    const payload = { probe: true, at: result.at, runtime: result.runtime };
    await store.setJSON(key, payload);
    const readBack = await store.get(key, { type: "json", consistency: "strong" });
    result.store = {
      ok: true,
      key,
      strongRead: true,
      matches: JSON.stringify(readBack) === JSON.stringify(payload),
      readBack,
    };
  } catch (err) {
    result.store = { ok: false, error: (err as Error).message };
  }

  return result;
}
