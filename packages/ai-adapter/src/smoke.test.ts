import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@skysentinel/ai-adapter", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@skysentinel/ai-adapter");
  });
});
