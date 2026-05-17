import { describe, expect, it, vi } from "vitest";

import {
  getHeavyBootWorkSkipReason,
  resolveDesiredRoute,
  runBootStep,
  scheduleOptionalBootWork,
  shouldSkipHeavyBootWorkForMemory,
} from "@/lib/appBoot";

describe("runBootStep", () => {
  it("returns completed results before the timeout", async () => {
    const result = await runBootStep("fast step", async () => "done", {
      timeoutMs: 50,
    });

    expect(result).toEqual({ status: "completed", value: "done" });
  });

  it("fails open on timeout and logs the stalled step", async () => {
    vi.useFakeTimers();
    const logger = vi.fn();

    const resultPromise = runBootStep(
      "slow step",
      () => new Promise<string>(() => undefined),
      {
        timeoutMs: 25,
        optional: true,
        logger,
      }
    );

    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual({ status: "timed_out" });
    expect(logger).toHaveBeenCalledWith(
      "[boot] slow step timed out after 25ms; continuing without blocking app."
    );

    vi.useRealTimers();
  });

  it("returns failed results and logs the error", async () => {
    const logger = vi.fn();
    const error = new Error("boom");

    const result = await runBootStep(
      "broken step",
      async () => {
        throw error;
      },
      {
        timeoutMs: 50,
        optional: true,
        logger,
      }
    );

    expect(result).toEqual({ status: "failed", error });
    expect(logger).toHaveBeenCalledWith(
      "[boot] broken step failed; continuing without blocking app.",
      error
    );
  });
});

describe("optional boot work", () => {
  it("detects low-memory devices", () => {
    expect(shouldSkipHeavyBootWorkForMemory({ lowMemory: true })).toBe(true);
    expect(shouldSkipHeavyBootWorkForMemory({ lowRamDevice: true })).toBe(true);
    expect(
      shouldSkipHeavyBootWorkForMemory({ availableMemoryBytes: 256 * 1024 * 1024 }),
    ).toBe(true);
    expect(
      shouldSkipHeavyBootWorkForMemory({ availableMemoryBytes: 1024 * 1024 * 1024 }),
    ).toBe(false);
    expect(getHeavyBootWorkSkipReason({ lowRamDevice: true })).toBe(
      "low_ram_device",
    );
  });

  it("delays optional boot work and supports cancellation", async () => {
    vi.useFakeTimers();
    const task = vi.fn();

    const scheduled = scheduleOptionalBootWork(task, { delayMs: 15_000 });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(task).not.toHaveBeenCalled();

    scheduled.cancel();
    await vi.advanceTimersByTimeAsync(1);
    expect(task).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe("resolveDesiredRoute", () => {
  it("keeps signed-out users on public auth routes", () => {
    expect(
      resolveDesiredRoute({
        pathname: "/auth/login",
        hasUser: false,
        hasProfile: false,
        questionnaireCompleted: false,
      })
    ).toBeNull();
  });

  it("sends signed-out users away from protected routes", () => {
    expect(
      resolveDesiredRoute({
        pathname: "/(chat)",
        hasUser: false,
        hasProfile: false,
        questionnaireCompleted: false,
        inChatGroup: true,
      })
    ).toBe("/auth/login");
  });

  it("routes signed-in users without a profile to profile onboarding", () => {
    expect(
      resolveDesiredRoute({
        pathname: "/auth/login",
        hasUser: true,
        hasProfile: false,
        questionnaireCompleted: false,
      })
    ).toBe("/onboarding/profile");
  });

  it("does not freeze routing solely because profile restore failed", () => {
    expect(
      resolveDesiredRoute({
        pathname: "/auth/login",
        hasUser: true,
        hasProfile: false,
        questionnaireCompleted: false,
        profileRestoreFailed: true,
      })
    ).toBe("/onboarding/profile");
  });

  it("routes signed-in users with an incomplete questionnaire to questionnaire onboarding", () => {
    expect(
      resolveDesiredRoute({
        pathname: "/onboarding/profile",
        hasUser: true,
        hasProfile: true,
        questionnaireCompleted: false,
      })
    ).toBe("/onboarding/questionnaire");
  });

  it("routes fully onboarded users to chat from auth and onboarding routes", () => {
    expect(
      resolveDesiredRoute({
        pathname: "/auth/signup",
        hasUser: true,
        hasProfile: true,
        questionnaireCompleted: true,
      })
    ).toBe("/(chat)");
  });

  it("routes fully onboarded users to model setup when required models are missing", () => {
    expect(
      resolveDesiredRoute({
        pathname: "/(chat)",
        hasUser: true,
        hasProfile: true,
        questionnaireCompleted: true,
        modelSetupRequired: true,
        inChatGroup: true,
      })
    ).toBe("/model-setup");

    expect(
      resolveDesiredRoute({
        pathname: "/model-setup",
        hasUser: true,
        hasProfile: true,
        questionnaireCompleted: true,
        modelSetupRequired: true,
      })
    ).toBeNull();
  });

  it("keeps fully onboarded users on chat, tabs, and setup routes", () => {
    expect(
      resolveDesiredRoute({
        pathname: "/(chat)",
        hasUser: true,
        hasProfile: true,
        questionnaireCompleted: true,
        inChatGroup: true,
      })
    ).toBeNull();

    expect(
      resolveDesiredRoute({
        pathname: "/(tabs)/explore",
        hasUser: true,
        hasProfile: true,
        questionnaireCompleted: true,
      })
    ).toBeNull();

    expect(
      resolveDesiredRoute({
        pathname: "/(tabs)/routine",
        hasUser: true,
        hasProfile: true,
        questionnaireCompleted: true,
      })
    ).toBeNull();

    expect(
      resolveDesiredRoute({
        pathname: "/setup",
        hasUser: true,
        hasProfile: true,
        questionnaireCompleted: true,
      })
    ).toBeNull();

    expect(
      resolveDesiredRoute({
        pathname: "/model-setup",
        hasUser: true,
        hasProfile: true,
        questionnaireCompleted: true,
      })
    ).toBe("/(chat)");
  });
});
