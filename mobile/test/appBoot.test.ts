import { describe, expect, it, vi } from "vitest";

import { 
  resolveDesiredRoute, 
  runBootStep,
  createBootTimeline,
  recordBootPhase,
  getBootSummary,
  emitBootPerfLog,
  getCurrentBootPhase,
  BOOT_PHASE_LABELS,
  perfLog,
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

describe("Boot Timeline Tracking", () => {
  it("creates an empty timeline with pending phases", () => {
    const timeline = createBootTimeline();
    expect(timeline.createdMs).toBeGreaterThan(0);
    expect(timeline.phases.auth_restore.status).toBe("pending");
    expect(timeline.phases.profile_restore.status).toBe("pending");
    expect(timeline.phases.model_readiness.status).toBe("pending");
    expect(timeline.phases.ui_ready.status).toBe("pending");
  });

  it("records phases correctly", () => {
    const timeline = createBootTimeline();
    recordBootPhase(timeline, "auth_restore", "completed");
    expect(timeline.phases.auth_restore.status).toBe("completed");
    expect(timeline.phases.auth_restore.endMs).not.toBeNull();
  });

  it("gets boot summary correctly", () => {
    const timeline = createBootTimeline();
    recordBootPhase(timeline, "auth_restore", "completed");
    const summary = getBootSummary(timeline);
    expect(summary.totalMs).toBeGreaterThanOrEqual(0);
    expect(summary.phases).toContain("auth_restore=completed");
  });

  it("emits boot perf log", () => {
    const timeline = createBootTimeline();
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    emitBootPerfLog(timeline);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("getCurrentBootPhase works correctly", () => {
    expect(getCurrentBootPhase({ authLoading: true, profileLoading: true })).toBe("auth_restore");
    expect(getCurrentBootPhase({ authLoading: false, profileLoading: true })).toBe("profile_restore");
    expect(getCurrentBootPhase({ authLoading: false, profileLoading: false, modelStatusLoading: true })).toBe("model_readiness");
    expect(getCurrentBootPhase({ authLoading: false, profileLoading: false, modelStatusLoading: false })).toBe("ui_ready");
  });

  it("has valid BOOT_PHASE_LABELS", () => {
    expect(BOOT_PHASE_LABELS.auth_restore).toBe("Restoring session…");
    expect(BOOT_PHASE_LABELS.profile_restore).toBe("Loading profile…");
    expect(BOOT_PHASE_LABELS.model_readiness).toBe("Checking model…");
    expect(BOOT_PHASE_LABELS.ui_ready).toBe("Ready");
  });
});

describe("perfLog utility", () => {
  it("formats perf log correctly", () => {
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    perfLog("test", "label", 100, { a: 1 });
    expect(consoleSpy).toHaveBeenCalledWith('[perf:test] | label | 100ms | {"a":1}');
    consoleSpy.mockRestore();
  });
});
