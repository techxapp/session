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
    proxy: { "/api": "http://localhost:8787" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // Excalidraw ships ESM with extensionless deep imports; let Vite resolve them.
    server: { deps: { inline: [/@excalidraw/, /roughjs/] } },
  },
});
