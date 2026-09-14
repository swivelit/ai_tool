export type SwicoBusyOperation = {
  id: number;
  navigationGeneration: number;
  requestId?: string;
  transportAttemptId?: string;
};

export type SwicoOperationIdentity = {
  requestId: string;
  transportAttemptId: string;
};

export type SwicoTransportCells = {
  activeRequestRef: { current: string | null };
  transportAttemptRef: { current: string | null };
};

/** Owns the single busy indicator shared by picker and preparation operations. */
export class SwicoBusyOperationController {
  private nextId = 0;
  private active: SwicoBusyOperation | null = null;

  begin(
    navigationGeneration: number,
    identity?: SwicoOperationIdentity,
  ): SwicoBusyOperation {
    const operation = {
      id: ++this.nextId,
      navigationGeneration,
      ...(identity || {}),
    };
    this.active = operation;
    return operation;
  }

  tryBegin(
    navigationGeneration: number,
    identity?: SwicoOperationIdentity,
  ): SwicoBusyOperation | null {
    if (this.active) return null;
    return this.begin(navigationGeneration, identity);
  }

  get isBusy(): boolean {
    return this.active !== null;
  }

  owns(operation: SwicoBusyOperation): boolean {
    return this.active?.id === operation.id;
  }

  /** Only the still-current operation may publish a post-cleanup result. */
  canPublish(operation: SwicoBusyOperation, navigationGeneration: number): boolean {
    return this.owns(operation) && operation.navigationGeneration === navigationGeneration;
  }

  abandon(navigationGeneration: number): boolean {
    if (!this.active || this.active.navigationGeneration >= navigationGeneration) return false;
    this.active = null;
    return true;
  }

  finish(operation: SwicoBusyOperation): boolean {
    if (!this.active || this.active.id !== operation.id) return false;
    this.active = null;
    return true;
  }
}

/**
 * Admit a preparation operation and publish its immutable request identity
 * before the first await. A rejected admission never mutates the cells.
 */
export function admitSwicoOperation(
  controller: SwicoBusyOperationController,
  navigationGeneration: number,
  identity: SwicoOperationIdentity,
  cells: SwicoTransportCells,
): SwicoBusyOperation | null {
  const operation = controller.tryBegin(navigationGeneration, identity);
  if (!operation) return null;
  cells.activeRequestRef.current = identity.requestId;
  cells.transportAttemptRef.current = identity.transportAttemptId;
  return operation;
}

/** Run the screen's deferred rejected-upload cleanup and publish only if the
 * original operation still owns the same conversation generation. */
export async function settleSwicoRejectedUpload(
  controller: SwicoBusyOperationController,
  operation: SwicoBusyOperation,
  navigationGeneration: number,
  cleanup: () => Promise<unknown>,
  publish: () => void,
): Promise<void> {
  await cleanup();
  if (controller.canPublish(operation, navigationGeneration)) publish();
}
