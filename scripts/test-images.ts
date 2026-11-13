import { createImageResolver, ImageError } from "../src/lib/images";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function isImageError(err: unknown, code: string): err is ImageError {
  return err instanceof ImageError && err.code === code;
}

async function main() {
  const saved = {
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH,
    mode: process.env.IMAGE_MODE,
  };
  process.env.GITHUB_REPO = "fuheng/demo-wiki";
  process.env.GITHUB_BRANCH = "main";

  const pub = createImageResolver("public");
  const response = await pub.resolve("public/uploads/a b.webp", new Request("http://localhost/img/x"));
  check("public 返回 302", response.status === 302, String(response.status));
  check(
    "public 指向 raw.githubusercontent.com",
    response.headers.get("location") ===
      "https://raw.githubusercontent.com/fuheng/demo-wiki/main/public/uploads/a%20b.webp",
    response.headers.get("location") ?? "",
  );
  check("public 带长缓存头", (response.headers.get("cache-control") ?? "").includes("s-maxage=86400"));

  try {
    await pub.resolve("public/../secret.png", new Request("http://localhost/img/x"));
    check("路径穿越被拒绝", false, "未抛错");
  } catch (err) {
    check("路径穿越被拒绝", isImageError(err, "invalid_path"));
  }

  try {
    await createImageResolver("private").resolve("public/uploads/a.webp", new Request("http://localhost/img/x"));
    check("private 明确抛 not_implemented", false, "未抛错");
  } catch (err) {
    check("private 明确抛 not_implemented", isImageError(err, "not_implemented"));
  }

  delete process.env.GITHUB_REPO;
  try {
    await pub.resolve("public/uploads/a.webp", new Request("http://localhost/img/x"));
    check("缺 GITHUB_REPO 明确报 not_configured", false, "未抛错");
  } catch (err) {
    check("缺 GITHUB_REPO 明确报 not_configured", isImageError(err, "not_configured"));
  }

  process.env.IMAGE_MODE = "weird";
  try {
    createImageResolver();
    check("非法 IMAGE_MODE 报 invalid_mode", false, "未抛错");
  } catch (err) {
    check("非法 IMAGE_MODE 报 invalid_mode", isImageError(err, "invalid_mode"));
  }

  // 还原环境，避免影响后续命令
  if (saved.repo === undefined) delete process.env.GITHUB_REPO;
  else process.env.GITHUB_REPO = saved.repo;
  if (saved.branch === undefined) delete process.env.GITHUB_BRANCH;
  else process.env.GITHUB_BRANCH = saved.branch;
  if (saved.mode === undefined) delete process.env.IMAGE_MODE;
  else process.env.IMAGE_MODE = saved.mode;

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
