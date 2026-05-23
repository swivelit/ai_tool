import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..");
const setupSource = fs.readFileSync(path.join(root, "app", "setup.tsx"), "utf8");

describe("wake phrase trainer source", () => {
  it("records samples and only marks ready from a model status/download flow", () => {
    expect(setupSource).toContain("apiPostForm");
    expect(setupSource).toContain("/api/openwakeword/enrollment/sample");
    expect(setupSource).toContain("/api/openwakeword/enrollment/finalize");
    expect(setupSource).toContain("/api/openwakeword/enrollment/model/status");
    expect(setupSource).toContain("downloadAndSaveWakeModelBundle");
    expect(setupSource).toContain("if (modelStatus.ready)");
    expect(setupSource).toContain('status: "pending"');
    expect(setupSource).not.toContain('positiveFiles.length >= MINIMUM_POSITIVE && negativeFiles.length >= MINIMUM_NEGATIVE\n        ? "ready_now"');
    expect(setupSource).not.toContain("powers wake detection");
  });

  it("does not show technical OpenWakeWord artifacts in normal setup UI", () => {
    expect(setupSource).not.toContain("Wake engine: native OpenWakeWord");
    expect(setupSource).not.toContain("Manifest:");
    expect(setupSource).not.toContain("Base phrase match");
    expect(setupSource).not.toContain("Dedicated training screen");
    expect(setupSource).not.toContain("Android speech diagnostics");
    expect(setupSource).not.toContain("Live transcript");
    expect(setupSource).not.toContain("Your captured phrase will appear here");
    expect(setupSource).not.toContain("Custom phrase recordings are uploaded");
    expect(setupSource).not.toContain("Hands-free only becomes active");
    expect(setupSource).not.toContain("Suggested negative sentences");
    expect(setupSource).not.toContain("Wake phrase model setup");
    expect(setupSource).not.toContain("styles.summaryCard");
    expect(setupSource).not.toContain("styles.stateRail");
  });
});
