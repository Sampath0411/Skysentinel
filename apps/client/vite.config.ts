import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client is a thin view over the local server (PRD §6.3). In dev,
// both REST and the frame WebSocket are proxied to the Fastify server so
// the app is served from one origin and no CORS path exists at all.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  build: {
    outDir: "dist",
    // No external assets: everything is bundled, per the offline rule
    // (PRD §4, FR-PLT-1).
    assetsInlineLimit: 100000000,
  },
});
