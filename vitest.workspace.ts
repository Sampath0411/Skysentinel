import { defineWorkspace } from "vitest/config";

// The apps carry their own vitest configs (the client needs jsdom, the server
// needs node and a live port), so listing them here is what puts them under the
// root `pnpm test` alongside the pure packages.
export default defineWorkspace([
  "packages/shared",
  "packages/sim-core",
  "packages/scenario",
  "packages/scoring",
  "packages/adaptive",
  "packages/ai-adapter",
  "packages/bots",
  "apps/server",
  "apps/client",
]);
