import { defineConfig } from "vitest/config";

// Node-only suite: Fastify, SQLite and a real WebSocket. The packages stay
// environment-agnostic; the server is where the boundary actually is.
export default defineConfig({
  test: {
    name: "server",
    environment: "node",
    // A live session is a real timer loop, so the socket suite needs more room
    // than a pure unit test does.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // These are integration tests, not unit tests: every file that drives a
    // session runs a real timer loop at a 1 ms interval, and the wall-clock
    // budgets inside those tests assume the machine is not already busy stepping
    // another run. Running the files in parallel makes them fight over one CPU,
    // which turns a load question into a timeout. Serially, each suite gets the
    // whole machine and the timings are what the tests assert.
    fileParallelism: false,
  },
});
