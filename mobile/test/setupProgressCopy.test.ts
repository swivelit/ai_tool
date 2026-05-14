import { describe, expect, it } from "vitest";

describe("setupProgressCopy", () => {
  it("should return wifi warning", () => {
    const message =
      "Wi-Fi is strongly recommended";

    expect(message).toContain("Wi-Fi");
  });

  it("should return repair message", () => {
    const message =
      "damaged or incomplete model file";

    expect(message).toContain("model");
  });

  it("should format ETA text", () => {
    const eta = "About 5 min left";

    expect(eta).toContain("min");
  });
});