import agentRegistry from "@/data/config/agent_registry.json";
import alignmentRules from "@/data/config/alignment_rules.json";
import memoryRules from "@/data/config/memory_rules.json";
import models from "@/data/config/models.json";
import orchestratorRoutes from "@/data/config/orchestrator_routes.json";
import profilerSlots from "@/data/config/profiler_slots.json";
import prompts from "@/data/config/prompts.json";
import workspaceManifest from "@/data/config/workspace_manifest.json";

export const LOCAL_AGENT_SEED_VERSION = String(
  (workspaceManifest as any)?.seedVersion || "seed-v1"
);

export const LOCAL_AGENT_JSON_SEEDS = [
  { relativePath: "config/models.json", payload: models },
  { relativePath: "config/profiler_slots.json", payload: profilerSlots },
  { relativePath: "config/orchestrator_routes.json", payload: orchestratorRoutes },
  { relativePath: "config/alignment_rules.json", payload: alignmentRules },
  { relativePath: "config/memory_rules.json", payload: memoryRules },
  { relativePath: "config/prompts.json", payload: prompts },
  { relativePath: "config/agent_registry.json", payload: agentRegistry },
  { relativePath: "config/workspace_manifest.json", payload: workspaceManifest },
] as const;

export const LOCAL_AGENT_ASSET_SEEDS = [
  {
    relativePath: "training/seed/classifier_dataset.csv",
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    moduleId: require("@/data/training/seed/classifier_dataset.csv"),
  },
  {
    relativePath: "training/seed/pipeline_questions.csv",
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    moduleId: require("@/data/training/seed/pipeline_questions.csv"),
  },
  {
    relativePath: "training/seed/profiler.jsonl",
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    moduleId: require("@/data/training/seed/profiler.jsonl"),
  },
  {
    relativePath: "training/seed/orchestrator.jsonl",
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    moduleId: require("@/data/training/seed/orchestrator.jsonl"),
  },
  {
    relativePath: "training/seed/alignment.jsonl",
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    moduleId: require("@/data/training/seed/alignment.jsonl"),
  },
  {
    relativePath: "training/seed/memory.jsonl",
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    moduleId: require("@/data/training/seed/memory.jsonl"),
  },
  {
    relativePath: "training/seed/rag.jsonl",
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    moduleId: require("@/data/training/seed/rag.jsonl"),
  },
  {
    relativePath: "rag/seed/fast_rag_replies.csv",
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    moduleId: require("@/data/rag/seed/fast_rag_replies.csv"),
  },
  {
    relativePath: "rag/seed/local_rag_keywords.csv",
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    moduleId: require("@/data/rag/seed/local_rag_keywords.csv"),
  },
  {
    relativePath: "rag/seed/local_rag_synonyms.csv",
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    moduleId: require("@/data/rag/seed/local_rag_synonyms.csv"),
  },
] as const;
