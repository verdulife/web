import { defineConfig } from "astro/config";
import tailwind from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://verdu.dev",
  output: "static",
  vite: {
    plugins: [tailwind()],
  },
  integrations: [sitemap()],
});
