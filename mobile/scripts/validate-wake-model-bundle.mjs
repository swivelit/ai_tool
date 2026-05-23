#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const envKeys = [
  "JAI_WAKE_MODEL_BUNDLE_DIR",
  "JAI_HEY_ELLI_OPENWAKEWORD_BUNDLE_DIR",
  "HEY_ELLI_OPENWAKEWORD_BUNDLE_DIR",
  "OPENWAKEWORD_HEY_ELLI_BUNDLE_DIR",
];
const bundleDir = envKeys.map((key) => process.env[key]).find(Boolean);

if (!bundleDir) {
  console.log(
    "SKIP wake model bundle validation: set JAI_WAKE_MODEL_BUNDLE_DIR or a Hey Elli bundle env var.",
  );
  process.exit(0);
}

const root = path.resolve(bundleDir);
const manifestPath = path.join(root, "manifest.json");

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(manifestPath)) {
  fail(`Wake model bundle is missing manifest.json: ${manifestPath}`);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`Wake model manifest is invalid JSON: ${error instanceof Error ? error.message : error}`);
}

const modelFiles = Array.isArray(manifest.model_files) ? manifest.model_files : [];
const byRole = new Map();
for (const entry of modelFiles) {
  const role = String(entry?.role || "").trim();
  const file = String(entry?.file || "").replace(/^\/+/, "");
  if (role && file) byRole.set(role, file);
}

for (const role of ["wake", "melspectrogram", "embedding"]) {
  const file = byRole.get(role);
  if (!file) {
    fail("Wake model manifest must include wake, melspectrogram, and embedding roles.");
  }
  if (!file.endsWith(".onnx")) {
    fail(`Wake model manifest role ${role} must point to an ONNX file, got: ${file}`);
  }
  const filePath = path.join(root, file);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`Wake model bundle role ${role} points to a missing file: ${filePath}`);
  }
  if (fs.statSync(filePath).size <= 0) {
    fail(`Wake model bundle role ${role} points to an empty file: ${filePath}`);
  }
}

const hash = crypto.createHash("sha256");
for (const role of ["wake", "melspectrogram", "embedding"]) {
  hash.update(fs.readFileSync(path.join(root, byRole.get(role))));
  hash.update("\n");
}
const digest = hash.digest("hex").slice(0, 12);

console.log(`PASS wake model bundle validation: ${root} (${digest})`);
