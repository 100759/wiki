export type ImageMode = "public" | "private";

export interface ImageResolver {
  resolve(path: string, req: Request): Promise<Response>;
}

export type ImageErrorCode = "not_implemented" | "invalid_path" | "not_configured" | "invalid_mode";

export class ImageError extends Error {
  readonly code: ImageErrorCode;

  constructor(code: ImageErrorCode, message: string) {
    super(message);
    this.name = "ImageError";
    this.code = code;
  }
}

export function imageModeFromEnv(): ImageMode {
  const raw = (process.env.IMAGE_MODE ?? "").trim().toLowerCase();
  if (!raw || raw === "public") return "public";
  if (raw === "private") return "private";
  throw new ImageError("invalid_mode", `IMAGE_MODE 只能是 public 或 private，收到：${raw}`);
}

function normalizeImagePath(input: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    throw new ImageError("invalid_path", "图片路径编码不合法");
  }
  const cleaned = decoded.replace(/^\/+/, "");
  const parts = cleaned.split("/");
  if (!cleaned || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ImageError("invalid_path", "图片路径不合法");
  }
  return cleaned;
}

function readRepo(): { repo: string; branch: string } {
  const repo = (process.env.GITHUB_REPO ?? "").trim();
  const branch = (process.env.GITHUB_BRANCH ?? "").trim() || "main";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new ImageError("not_configured", "GITHUB_REPO 未配置或格式不对，应为 owner/repo");
  }
  return { repo, branch };
}

function encodePath(p: string): string {
  return p.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/**
 * 图片读取双后端。
 * - public：302 到 raw.githubusercontent.com（仓库公开时的零成本路径）
 * - private：M2 用只读 token 的 Node 代理取流；M1 明确抛 not_implemented，不降级成 public
 */
export function createImageResolver(mode: ImageMode = imageModeFromEnv()): ImageResolver {
  return {
    async resolve(input: string): Promise<Response> {
      const imagePath = normalizeImagePath(input);

      if (mode === "private") {
        // TODO(M2)：带只读 token 调 GitHub，流式返回，Cache-Control: public, s-maxage=86400。
        throw new ImageError(
          "not_implemented",
          "IMAGE_MODE=private 的图片代理尚未实现（M2 接真实 GitHub 时补），不会降级为 public",
        );
      }

      const { repo, branch } = readRepo();
      const location = `https://raw.githubusercontent.com/${repo}/${encodePath(branch)}/${encodePath(imagePath)}`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: location,
          "Cache-Control": "public, s-maxage=86400",
        },
      });
    },
  };
}
