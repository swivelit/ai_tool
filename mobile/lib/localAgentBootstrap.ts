import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";

import {
  LOCAL_AGENT_ASSET_SEEDS,
  LOCAL_AGENT_JSON_SEEDS,
  LOCAL_AGENT_SEED_VERSION,
} from "./localAgentSeedManifest";

const documentDir = FileSystem.documentDirectory || "";
export const LOCAL_AGENT_DATA_DIR = `${documentDir}data`;

const BOOTSTRAP_STATE_PATH = `${LOCAL_AGENT_DATA_DIR}/_bootstrap_state.json`;

function parentDir(path: string) {
  return path.split("/").slice(0, -1).join("/");
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

async function writeUtf8(path: string, content: string) {
  await ensureDir(parentDir(path));
  await FileSystem.writeAsStringAsync(path, content, {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

async function readBootstrapState() {
  try {
    if (!(await exists(BOOTSTRAP_STATE_PATH))) return null;
    const raw = await FileSystem.readAsStringAsync(BOOTSTRAP_STATE_PATH);
    return JSON.parse(raw) as { seedVersion?: string; bootstrappedAt?: string } | null;
  } catch {
    return null;
  }
}

async function copyBundledAsset(moduleId: number, targetPath: string) {
  const asset = Asset.fromModule(moduleId);
  if (!asset.localUri) {
    await asset.downloadAsync();
  }
  const sourceUri = asset.localUri || asset.uri;
  if (!sourceUri) {
    throw new Error(`Seed asset missing for ${targetPath}`);
  }
  await ensureDir(parentDir(targetPath));
  if (await exists(targetPath)) {
    await FileSystem.deleteAsync(targetPath, { idempotent: true });
  }
  await FileSystem.copyAsync({ from: sourceUri, to: targetPath });
}

export async function ensureLocalAgentSeedData() {
  if (!documentDir) {
    throw new Error("Expo documentDirectory is unavailable.");
  }

  await ensureDir(LOCAL_AGENT_DATA_DIR);

  const bootstrapState = await readBootstrapState();
  const needsRefresh = bootstrapState?.seedVersion !== LOCAL_AGENT_SEED_VERSION;

  for (const seed of LOCAL_AGENT_JSON_SEEDS) {
    const targetPath = `${LOCAL_AGENT_DATA_DIR}/${seed.relativePath}`;
    if (needsRefresh || !(await exists(targetPath))) {
      await writeUtf8(targetPath, JSON.stringify(seed.payload, null, 2));
    }
  }

  for (const seed of LOCAL_AGENT_ASSET_SEEDS) {
    const targetPath = `${LOCAL_AGENT_DATA_DIR}/${seed.relativePath}`;
    if (needsRefresh || !(await exists(targetPath))) {
      await copyBundledAsset(seed.moduleId, targetPath);
    }
  }

  await writeUtf8(
    BOOTSTRAP_STATE_PATH,
    JSON.stringify(
      {
        seedVersion: LOCAL_AGENT_SEED_VERSION,
        bootstrappedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  return {
    dataDir: LOCAL_AGENT_DATA_DIR,
    seedVersion: LOCAL_AGENT_SEED_VERSION,
  };
}
