import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveWebCapabilityFile } from "./src/capability-path.js";

const capabilityFile = resolveWebCapabilityFile(__dirname, process.env.COWORK_DATA_DIR);

// Lectura perezosa POR PETICIÓN, nunca al construir la config: Vite puede arrancar antes
// que el backend haya escrito el archivo (P14), y una lectura única dejaría el arranque
// sin cabecera para siempre. El navegador nunca ve este valor.
function readCapabilityHeader(): string | undefined {
  try {
    return readFileSync(capabilityFile, "utf8");
  } catch {
    return undefined;
  }
}

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
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Connection", "keep-alive");
            const capability = readCapabilityHeader();
            if (capability !== undefined) proxyReq.setHeader("x-ronin-capability", capability);
          });
        },
      },
    },
  },
});
