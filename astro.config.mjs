import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import edgeone from "@edgeone/astro";

// M1：全部读写走本地文件，不接 EdgeOne Blob / GitHub。
// adapter 已就位，M2 接平台时不需要换 Astro 配置。
export default defineConfig({
  output: "server",
  adapter: edgeone(),
  integrations: [react(), tailwind({ applyBaseStyles: false })],
  server: { port: 4321 },
});
