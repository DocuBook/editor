import { describe, expect, it } from "vitest";
import { boundContextResult } from "../../../frontend/utils/aiContext";

describe("boundContextResult", () => {
  it("serializes escaped strings without changing JSON semantics", () => {
    const value = { text: 'quote " slash \\ newline\n emoji 😀 lone \ud800' };
    const result = boundContextResult(value);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.split("\n").slice(1).join("\n"))).toEqual(value);
  });

  it("rejects oversized strings without serializing the full value", () => {
    expect(boundContextResult("x".repeat(300_000))).toBeNull();
  });
});
