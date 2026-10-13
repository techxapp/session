import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    // Excalidraw reads this at runtime.
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  server: {
    port: 5173,
    proxy: {
      // ws: the cloud speech relay (/api/stt) is a WebSocket on the API server.
      "/api": { target: "http://localhost:8787", ws: true },
      // Speech-to-text sidecar (stt/server.py); 127.0.0.1 because it binds IPv4 only.
      "/stt": { target: "ws://127.0.0.1:8789", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // Excalidraw ships ESM with extensionless deep imports; let Vite resolve them.
    server: { deps: { inline: [/@excalidraw/, /roughjs/] } },
  },
});
