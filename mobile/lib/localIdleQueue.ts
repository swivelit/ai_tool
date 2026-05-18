type LocalIdleTask = () => Promise<unknown> | unknown;
 
export type LocalIdleJobPriority = "low" | "normal" | "high";
 
const PRIORITY_WEIGHT: Record<LocalIdleJobPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};
 
export type LocalIdleJobOptions = {
  delayMs?: number;
  staggerMs?: number;
  priority?: LocalIdleJobPriority;
  onComplete?: () => void;
};
 
type LocalIdleJob = {
  id: number;
  label: string;
  task: LocalIdleTask;
  delayMs: number;
  priority: LocalIdleJobPriority;
  createdAt: number;
  onComplete?: () => void;
};
 
type InteractionHandle = {
  cancel?: () => void;
};
 
type InteractionManagerLike = {
  runAfterInteractions?: (task: () => void) => InteractionHandle | void;
};
 
declare const require:
  | ((moduleName: string) => { InteractionManager?: InteractionManagerLike })
  | undefined;
 
const DEFAULT_INITIAL_DELAY_MS = 80;
const DEFAULT_STAGGER_MS = 350;
const MAX_FLUSH_JOBS = 1000;
 
let queue: LocalIdleJob[] = [];
let nextId = 1;
let running = false;
let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
let scheduledInteraction: InteractionHandle | null = null;
let cachedInteractionManager: InteractionManagerLike | null | undefined;
 
function isTestEnvironment() {
  return (
    String((globalThis as any)?.process?.env?.NODE_ENV || "").toLowerCase() ===
    "test"
  );
}
 
function getInteractionManager(): InteractionManagerLike | null {
  if (cachedInteractionManager !== undefined) {
    return cachedInteractionManager;
  }
 
  try {
    const maybeRequire = typeof require === "function" ? require : null;
    cachedInteractionManager =
      maybeRequire?.("react-native")?.InteractionManager || null;
  } catch {
    cachedInteractionManager = null;
  }
 
  return cachedInteractionManager;
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
  } finally {
    try {
      job.onComplete?.();
    } catch {
      // ignore callback errors
    }
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
 
function scheduleNext() {
  if (isTestEnvironment() || running || scheduledTimer || scheduledInteraction) {
    return;
  }
 
  const next = queue[0];
  if (!next) return;
 
  const scheduleTimer = () => {
    scheduledInteraction = null;
    scheduledTimer = setTimeout(() => {
      scheduledTimer = null;
      void drainOne();
    }, next.delayMs);
  };
 
  const interactionManager = getInteractionManager();
  if (typeof interactionManager?.runAfterInteractions === "function") {
    scheduledInteraction =
      interactionManager.runAfterInteractions(scheduleTimer) || null;
    return;
  }
 
  scheduleTimer();
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
 
function sortQueueByPriority() {
  queue.sort(
    (a, b) =>
      PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority] ||
      a.id - b.id,
  );
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
  const priority: LocalIdleJobPriority =
    options.priority && PRIORITY_WEIGHT[options.priority] != null
      ? options.priority
      : "normal";
  const job: LocalIdleJob = {
    id: nextId,
    label: String(label || "idle_job"),
    task,
    delayMs: baseDelayMs + queuedAhead * staggerMs,
    priority,
    createdAt: Date.now(),
    onComplete: options.onComplete,
  };
  nextId += 1;
  queue.push(job);
  sortQueueByPriority();
  scheduleNext();
  return job.id;
}
 
export function getQueueSnapshot() {
  return queue.map((job) => ({
    id: job.id,
    label: job.label,
    priority: job.priority,
    delayMs: job.delayMs,
    createdAt: job.createdAt,
  }));
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
 
 
