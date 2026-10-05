import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The browser half of the app, so the suite runs in jsdom rather than node. Only
// the pieces that make sense without a server are covered here — the pure view
// models and the thin components — because anything that drives a live session is
// tested against the real server in `apps/server`.
export default defineConfig({
  plugins: [react()],
  test: {
    name: "client",
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // RTL's cleanup is per-file; a browser env is heavier than node, and these are
    // unit-shaped tests, so one file at a time keeps a slow machine from turning
    // into a timeout.
    fileParallelism: false,
  },
});
