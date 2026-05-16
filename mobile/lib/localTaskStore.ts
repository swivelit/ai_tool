import * as FileSystem from "expo-file-system/legacy";

const documentDir = FileSystem.documentDirectory || "";
const DATA_DIR = `${documentDir}data`;
const TASKS_DIR = `${DATA_DIR}/tasks`;

export type LocalTaskRecord = {
  id: string;
  title: string;
  details?: string;
  datetimeText?: string | null;
  isoDatetime?: string | null;
  status: "scheduled" | "draft" | "done";
  createdAt: string;
};

function nowIso() {
  return new Date().toISOString();
}

function simpleHash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0).toString(16);
}

function parseJsonLoose<T>(raw: any, fallback: T): T {
  if (raw && typeof raw === "object") return raw as T;
  const text = String(raw || "").trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function exists(path: string) {
  const info = await FileSystem.getInfoAsync(path);
  return Boolean(info.exists);
}

async function ensureDir(path: string) {
  if (!path) return;
  if (!(await exists(path))) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    if (!(await exists(path))) return fallback;
    const raw = await FileSystem.readAsStringAsync(path);
    return parseJsonLoose<T>(raw, fallback);
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, payload: any) {
  const directory = path.split("/").slice(0, -1).join("/");
  if (directory) await ensureDir(directory);
  await FileSystem.writeAsStringAsync(path, JSON.stringify(payload, null, 2), {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

export function scheduledTasksPath(userId: number) {
  return `${TASKS_DIR}/${userId}.json`;
}

export async function loadTasks(userId: number) {
  return readJson<LocalTaskRecord[]>(scheduledTasksPath(userId), []);
}

export async function saveTasks(userId: number, tasks: LocalTaskRecord[]) {
  await writeJson(scheduledTasksPath(userId), tasks);
}

export async function saveScheduledTask(
  userId: number,
  task: Omit<LocalTaskRecord, "id" | "createdAt">,
) {
  const current = await loadTasks(userId);
  const row: LocalTaskRecord = {
    id: `${Date.now()}_${simpleHash(JSON.stringify(task))}`,
    createdAt: nowIso(),
    ...task,
  };
  current.unshift(row);
  await saveTasks(userId, current.slice(0, 500));
  return row;
}
