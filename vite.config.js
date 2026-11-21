import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 2270,
    strictPort: true,
    host: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:2271",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
