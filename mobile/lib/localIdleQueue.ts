import { InteractionManager } from "react-native";

type LocalIdleTask = () => Promise<unknown> | unknown;

export type LocalIdleJobOptions = {
  delayMs?: number;
  staggerMs?: number;
};

type LocalIdleJob = {
  id: number;
  label: string;
  task: LocalIdleTask;
  delayMs: number;
  createdAt: number;
};

type InteractionHandle = {
  cancel?: () => void;
};

type InteractionManagerLike = {
  runAfterInteractions?: (task: () => void) => InteractionHandle | void;
};

const DEFAULT_INITIAL_DELAY_MS = 80;
const DEFAULT_STAGGER_MS = 350;
const MAX_FLUSH_JOBS = 1000;

let queue: LocalIdleJob[] = [];
let nextId = 1;
let running = false;
let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
let scheduledInteraction: InteractionHandle | null = null;

function isTestEnvironment() {
  return (
    String((globalThis as any)?.process?.env?.NODE_ENV || "").toLowerCase() ===
    "test"
  );
}

function getInteractionManager(): InteractionManagerLike | null {
  if (isTestEnvironment()) return null;
  return (InteractionManager as InteractionManagerLike | null | undefined) || null;
}

function logIdleError(label: string, error: unknown) {
  if (Boolean((globalThis as any).__DEV__)) {
    console.warn(`[localIdleQueue:${label}]`, error);
  }
}

async function runJob(job: LocalIdleJob) {
  try {
    await job.task();
  } catch (error) {
    logIdleError(job.label, error);
  }
}

function cancelScheduledWork() {
  if (scheduledTimer) {
    clearTimeout(scheduledTimer);
    scheduledTimer = null;
  }
  if (scheduledInteraction?.cancel) {
    scheduledInteraction.cancel();
  }
  scheduledInteraction = null;
}

function scheduleWithTimer(delayMs: number) {
  scheduledInteraction = null;
  scheduledTimer = setTimeout(() => {
    scheduledTimer = null;
    void drainOne();
  }, delayMs);
}

function scheduleNext() {
  if (isTestEnvironment() || running || scheduledTimer || scheduledInteraction) {
    return;
  }

  const next = queue[0];
  if (!next) return;

  const scheduleTimer = () => scheduleWithTimer(next.delayMs);

  try {
    const interactionManager = getInteractionManager();
    if (typeof interactionManager?.runAfterInteractions === "function") {
      const handle =
        interactionManager.runAfterInteractions(scheduleTimer) || null;
      scheduledInteraction = scheduledTimer
        ? null
        : handle || { cancel: undefined };
      return;
    }
  } catch (error) {
    logIdleError("schedule_interaction", error);
  }

  if (!scheduledTimer) {
    scheduleTimer();
  }
}

async function drainOne() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;

  running = true;
  try {
    await runJob(job);
  } finally {
    running = false;
    scheduleNext();
  }
}

export function enqueueLocalIdleJob(
  label: string,
  task: LocalIdleTask,
  options: LocalIdleJobOptions = {},
) {
  const queuedAhead = queue.length + (running ? 1 : 0);
  const baseDelayMs = Math.max(
    0,
    Number(options.delayMs ?? DEFAULT_INITIAL_DELAY_MS) || 0,
  );
  const staggerMs = Math.max(
    0,
    Number(options.staggerMs ?? DEFAULT_STAGGER_MS) || 0,
  );
  const job: LocalIdleJob = {
    id: nextId,
    label: String(label || "idle_job"),
    task,
    delayMs: baseDelayMs + queuedAhead * staggerMs,
    createdAt: Date.now(),
  };
  nextId += 1;
  queue.push(job);
  scheduleNext();
  return job.id;
}

export const __idleQueueTestUtils = {
  async flush() {
    cancelScheduledWork();
    let count = 0;
    while (queue.length && count < MAX_FLUSH_JOBS) {
      count += 1;
      const job = queue.shift();
      if (job) {
        await runJob(job);
      }
    }
  },
  pendingCount() {
    return queue.length + (running ? 1 : 0);
  },
  pendingJobs() {
    return queue.map((job) => ({
      id: job.id,
      label: job.label,
      delayMs: job.delayMs,
      createdAt: job.createdAt,
    }));
  },
  clear() {
    cancelScheduledWork();
    queue = [];
    running = false;
  },
};
