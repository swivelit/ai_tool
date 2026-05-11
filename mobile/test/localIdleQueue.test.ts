import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __idleQueueTestUtils,
  enqueueLocalIdleJob,
} from "../lib/localIdleQueue";

describe("local idle queue", () => {
  beforeEach(() => {
    __idleQueueTestUtils.clear();
    vi.restoreAllMocks();
    delete (globalThis as any).__DEV__;
  });

  it("queues jobs without running them immediately in tests", async () => {
    const job = vi.fn();

    enqueueLocalIdleJob("one", job);
    await Promise.resolve();

    expect(__idleQueueTestUtils.pendingCount()).toBe(1);
    expect(job).not.toHaveBeenCalled();
  });

  it("flushes queued jobs explicitly in test mode", async () => {
    const order: string[] = [];

    enqueueLocalIdleJob("one", () => order.push("one"));
    enqueueLocalIdleJob("two", () => order.push("two"));

    await __idleQueueTestUtils.flush();

    expect(order).toEqual(["one", "two"]);
    expect(__idleQueueTestUtils.pendingCount()).toBe(0);
  });

  it("staggers jobs", () => {
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

  it("swallows errors and keeps flushing later jobs", async () => {
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
    const job = vi.fn();

    enqueueLocalIdleJob("manual", job, { delayMs: 0, staggerMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(job).not.toHaveBeenCalled();
    await __idleQueueTestUtils.flush();
    expect(job).toHaveBeenCalledTimes(1);
  });
});
