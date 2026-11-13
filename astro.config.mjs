import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import edgeone from "@edgeone/astro";

// M1：全部读写走本地文件，不接 EdgeOne Blob / GitHub。
// adapter 已就位，M2 接平台时不需要换 Astro 配置。
export default defineConfig({
  output: "server",
  // 样式很少，内联进 HTML 可以省掉一次阻塞请求（首屏更快）
  build: { inlineStylesheets: "always" },
  adapter: edgeone(),
  integrations: [react(), tailwind({ applyBaseStyles: false })],
  server: { port: 4321 },
});
