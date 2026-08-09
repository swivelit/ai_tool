import type { RepositorySnapshot } from "./swicoTypes";

export type ActiveRepository = RepositorySnapshot & { owner_uid: string; thread_id: string | null; progress?: number; error?: string };

export function repositoryUsable(repository: ActiveRepository | null, ownerUid: string, threadId: string | null, now = Date.now()) {
  return Boolean(repository
    && repository.owner_uid === ownerUid
    && repository.thread_id === threadId
    && repository.status === "ready"
    && (!repository.expires_at || Date.parse(repository.expires_at) > now));
}

export function repositoryExpired(repository: Pick<ActiveRepository, "expires_at" | "status"> | null, now = Date.now()) {
  return Boolean(repository && repository.status === "ready" && repository.expires_at && Date.parse(repository.expires_at) <= now);
}

export function repositoryDetachCode(code: string) {
  return ["repository_expired", "repository_not_found", "repository_unavailable"].includes(code);
}

