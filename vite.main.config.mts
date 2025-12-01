import { defineConfig } from "vite";
import path from "path";

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "./src"),
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      external: ["better-sqlite3"],
    },
  },
});
