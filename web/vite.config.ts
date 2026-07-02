import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // 5180 (not Vite's default 5173) to avoid colliding with the Liebre app's
    // PWA service worker registered at localhost:5173.
    port: 5180,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        // SSE needs streaming, not buffering
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("Connection", "keep-alive"));
        },
      },
    },
  },
});
