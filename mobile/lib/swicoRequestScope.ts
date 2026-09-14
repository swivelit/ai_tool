export type SwicoRequestScope = {
  navigationGeneration: number;
  transportAttemptId: string;
  requestId: string;
  threadId: string | null;
};

export type SwicoScopeState = {
  navigationGeneration: number;
  transportAttemptId: string | null;
  requestId: string | null;
  threadId: string | null;
};

export function captureSwicoScope(
  navigationGeneration: number,
  transportAttemptId: string,
  requestId: string,
  threadId: string | null,
): SwicoRequestScope {
  return { navigationGeneration, transportAttemptId, requestId, threadId };
}

export function isSwicoScopeCurrent(
  scope: SwicoRequestScope,
  state: SwicoScopeState,
): boolean {
  return (
    state.navigationGeneration === scope.navigationGeneration
    && state.transportAttemptId === scope.transportAttemptId
    && state.requestId === scope.requestId
    && state.threadId === scope.threadId
  );
}

export type SwicoHistoryScope = {
  kind: "threads" | "messages";
  generation: number;
  threadId: string | null;
  archived: boolean;
};

export function captureSwicoHistoryScope(
  kind: SwicoHistoryScope["kind"],
  generation: number,
  threadId: string | null,
  archived: boolean,
): SwicoHistoryScope {
  return { kind, generation, threadId, archived };
}

export function isSwicoHistoryScopeCurrent(
  scope: SwicoHistoryScope,
  state: { generation: number; activeThreadId: string | null; archived: boolean },
): boolean {
  return (
    scope.generation === state.generation
    && scope.archived === state.archived
    && (scope.kind === "threads" || scope.threadId === state.activeThreadId)
  );
}
