/**
 * Test setup for the client suite.
 *
 * Adds the DOM matchers the component tests read (`toBeInTheDocument` and friends),
 * and registers React Testing Library's cleanup. RTL registers cleanup itself only
 * when the test framework's hooks are global; this suite imports `describe`/`it`
 * from `vitest` instead, so without the explicit `afterEach` each render stays in
 * the document and a later test's `getByRole` finds the earlier one too.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// jsdom implements no layout, so `ResizeObserver` — which the canvas-backed
// components use to track their host width — does not exist there. A no-op stand-in
// is enough: the components read `clientWidth` themselves, and the tests that care
// about geometry drive it explicitly.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);
