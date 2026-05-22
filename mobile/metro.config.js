const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.assetExts = Array.from(
  new Set([...(config.resolver.assetExts || []), "csv", "jsonl", "gguf", "onnx", "ort", "tflite"])
);

module.exports = config;
