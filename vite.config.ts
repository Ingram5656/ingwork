import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发端口固定 1420，和 src-tauri/tauri.conf.json 里的 devUrl 对应
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
