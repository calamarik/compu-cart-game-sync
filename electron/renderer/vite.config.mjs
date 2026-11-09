// Offline desktop renderer build (Electron loads it from file://, so base must be relative).
// Usage: bunx vite build --config electron/renderer/vite.config.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

export default defineConfig({
  root: here,
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.join(root, "src") } },
  build: { outDir: path.join(root, "electron-release/renderer"), emptyOutDir: true, assetsInlineLimit: 0 },
});
