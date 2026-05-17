import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type IdleQueueModule = typeof import("../lib/localIdleQueue");
const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(testDir, "../lib/localIdleQueue.ts");

async function loadIdleQueue() {
  return import("../lib/localIdleQueue") as Promise<IdleQueueModule>;
}

describe("local idle queue", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as any).__DEV__;
    delete (globalThis as any).require;
  });

  afterEach(async () => {
    const idleQueue = await loadIdleQueue();
    idleQueue.__idleQueueTestUtils.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock("react-native");
    delete (globalThis as any).__DEV__;
    delete (globalThis as any).require;
  });

  it("queues jobs without running them immediately in tests", async () => {
    const { __idleQueueTestUtils, enqueueLocalIdleJob } = await loadIdleQueue();
    const job = vi.fn();

    enqueueLocalIdleJob("one", job);
    await Promise.resolve();

    expect(__idleQueueTestUtils.pendingCount()).toBe(1);
    expect(job).not.toHaveBeenCalled();
  });

  it("flushes queued jobs explicitly in test mode", async () => {
    const { __idleQueueTestUtils, enqueueLocalIdleJob } = await loadIdleQueue();
    const order: string[] = [];

    enqueueLocalIdleJob("one", () => order.push("one"));
    enqueueLocalIdleJob("two", () => order.push("two"));

    await __idleQueueTestUtils.flush();

    expect(order).toEqual(["one", "two"]);
    expect(__idleQueueTestUtils.pendingCount()).toBe(0);
  });

  it("staggers jobs", async () => {
    const { __idleQueueTestUtils, enqueueLocalIdleJob } = await loadIdleQueue();

    enqueueLocalIdleJob("one", () => undefined, {
      delayMs: 10,
      staggerMs: 25,
    });
    enqueueLocalIdleJob("two", () => undefined, {
      delayMs: 10,
      staggerMs: 25,
    });
    enqueueLocalIdleJob("three", () => undefined, {
      delayMs: 10,
      staggerMs: 25,
    });

    expect(__idleQueueTestUtils.pendingJobs().map((job) => job.delayMs)).toEqual([
      10,
      35,
      60,
    ]);
  });

  it("does not call global require(\"react-native\") when scheduling", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "development");
    const globalRequire = vi.fn(() => {
      throw new Error('Requiring unknown module "react-native"');
    });
    (globalThis as any).require = globalRequire;
    const { enqueueLocalIdleJob } = await loadIdleQueue();
    const job = vi.fn();

    expect(() =>
      enqueueLocalIdleJob("no_dynamic_require", job, {
        delayMs: 5,
        staggerMs: 0,
      }),
    ).not.toThrow();

    await vi.advanceTimersByTimeAsync(5);

    expect(globalRequire).not.toHaveBeenCalled();
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("source does not contain dynamic react-native require patterns", () => {
    const source = fs.readFileSync(sourcePath, "utf8");

    expect(source).toContain('import { InteractionManager } from "react-native";');
    expect(source).not.toContain('require("react-native")');
    expect(source).not.toContain("require('react-native')");
    expect(source).not.toContain('maybeRequire?.("react-native")');
    expect(source).not.toContain("maybeRequire?.('react-native')");
  });

  it("does not throw when scheduling a job", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "development");
    const { enqueueLocalIdleJob } = await loadIdleQueue();

    expect(() =>
      enqueueLocalIdleJob("schedule", () => undefined, {
        delayMs: 1,
        staggerMs: 0,
      }),
    ).not.toThrow();

    await vi.advanceTimersByTimeAsync(1);
  });

  it("falls back to timer when InteractionManager is unavailable", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "development");
    vi.doMock("react-native", () => ({
      InteractionManager: undefined,
      default: { InteractionManager: undefined },
    }));
    const { enqueueLocalIdleJob } = await loadIdleQueue();
    const job = vi.fn();

    enqueueLocalIdleJob("timer_fallback", job, {
      delayMs: 10,
      staggerMs: 0,
    });

    await vi.advanceTimersByTimeAsync(9);
    expect(job).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("falls back to timer when InteractionManager.runAfterInteractions throws", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "development");
    const runAfterInteractions = vi.fn(() => {
      throw new Error("interaction scheduler failed");
    });
    vi.doMock("react-native", () => ({
      InteractionManager: { runAfterInteractions },
      default: { InteractionManager: { runAfterInteractions } },
    }));
    const { enqueueLocalIdleJob } = await loadIdleQueue();
    const job = vi.fn();

    expect(() =>
      enqueueLocalIdleJob("throwing_interaction_manager", job, {
        delayMs: 10,
        staggerMs: 0,
      }),
    ).not.toThrow();

    await vi.advanceTimersByTimeAsync(10);

    expect(runAfterInteractions).toHaveBeenCalledTimes(1);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("swallows errors and keeps flushing later jobs", async () => {
    const { __idleQueueTestUtils, enqueueLocalIdleJob } = await loadIdleQueue();
    (globalThis as any).__DEV__ = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const later = vi.fn();

    enqueueLocalIdleJob("bad", () => {
      throw new Error("bad idle job");
    });
    enqueueLocalIdleJob("later", later);

    await __idleQueueTestUtils.flush();

    expect(later).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[localIdleQueue:bad]",
      expect.any(Error),
    );
    expect(__idleQueueTestUtils.pendingCount()).toBe(0);
  });

  it("does not run automatically in test mode unless flushed", async () => {
    const { __idleQueueTestUtils, enqueueLocalIdleJob } = await loadIdleQueue();
    const job = vi.fn();

    enqueueLocalIdleJob("manual", job, { delayMs: 0, staggerMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(job).not.toHaveBeenCalled();
    await __idleQueueTestUtils.flush();
    expect(job).toHaveBeenCalledTimes(1);
  });
});
