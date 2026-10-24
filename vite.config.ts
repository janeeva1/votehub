import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: path.resolve("web"),
  plugins: [react()],
  resolve: { alias: { "@shared": path.resolve("shared") } },
  build: { outDir: path.resolve("dist/public"), emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
