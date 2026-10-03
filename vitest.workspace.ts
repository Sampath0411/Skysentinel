import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/shared",
  "packages/sim-core",
  "packages/scenario",
  "packages/scoring",
  "packages/adaptive",
  "packages/ai-adapter",
  "packages/bots",
]);