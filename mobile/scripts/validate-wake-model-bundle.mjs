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
const requiredRoles = ["wake", "melspectrogram", "embedding"];

function safeFlatOnnxFileName(value, role) {
  const file = String(value || "").trim();
  const unsafe =
    !file ||
    file.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(file) ||
    file.includes("/") ||
    file.includes("\\") ||
    file === "." ||
    file === "..";
  if (unsafe) {
    fail(`Wake model manifest role ${role || "model"} has an unsafe file path: ${file || "(empty)"}`);
  }
  if (!file.endsWith(".onnx")) {
    fail(`Wake model manifest role ${role} must point to an ONNX file, got: ${file}`);
  }
  return file;
}

function normalizeSha(value, file) {
  const sha = String(value || "").trim().toLowerCase();
  if (!sha) return "";
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    fail(`Wake model manifest has invalid sha256 metadata for ${file}`);
  }
  return sha;
}

for (const entry of modelFiles) {
  const role = String(entry?.role || "").trim();
  if (!requiredRoles.includes(role)) {
    fail("Wake model manifest roles must be wake, melspectrogram, or embedding.");
  }
  const file = safeFlatOnnxFileName(entry?.file, role);
  if (byRole.has(role)) {
    fail(`Wake model manifest contains duplicate ${role} entries.`);
  }
  byRole.set(role, { file, expectedBytes: entry?.bytes, expectedSha: normalizeSha(entry?.sha256, file) });
}

for (const role of requiredRoles) {
  const entry = byRole.get(role);
  if (!entry?.file) {
    fail("Wake model manifest must include wake, melspectrogram, and embedding roles.");
  }
  const filePath = path.join(root, entry.file);
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== root) {
    fail(`Wake model manifest role ${role} escapes the bundle directory.`);
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`Wake model bundle role ${role} points to a missing file: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (stat.size <= 0) {
    fail(`Wake model bundle role ${role} points to an empty file: ${filePath}`);
  }
  if (typeof entry.expectedBytes !== "undefined" && entry.expectedBytes !== null) {
    const expectedBytes = Number(entry.expectedBytes);
    if (!Number.isInteger(expectedBytes) || expectedBytes < 0) {
      fail(`Wake model manifest has invalid byte length for ${entry.file}`);
    }
    if (stat.size !== expectedBytes) {
      fail(`Wake model bundle byte length mismatch for ${entry.file}`);
    }
  }
  if (entry.expectedSha) {
    const actualSha = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    if (actualSha !== entry.expectedSha) {
      fail(`Wake model bundle SHA-256 mismatch for ${entry.file}`);
    }
  }
}

const hash = crypto.createHash("sha256");
for (const role of requiredRoles) {
  hash.update(fs.readFileSync(path.join(root, byRole.get(role).file)));
  hash.update("\n");
}
const digest = hash.digest("hex").slice(0, 12);

console.log(`PASS wake model bundle validation: ${root} (${digest})`);
