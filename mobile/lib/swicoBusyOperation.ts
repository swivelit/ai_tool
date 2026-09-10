export type SwicoBusyOperation = {
  id: number;
  navigationGeneration: number;
};

/** Owns the single busy indicator shared by picker and preparation operations. */
export class SwicoBusyOperationController {
  private nextId = 0;
  private active: SwicoBusyOperation | null = null;

  begin(navigationGeneration: number): SwicoBusyOperation {
    const operation = { id: ++this.nextId, navigationGeneration };
    this.active = operation;
    return operation;
  }

  tryBegin(navigationGeneration: number): SwicoBusyOperation | null {
    if (this.active) return null;
    return this.begin(navigationGeneration);
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
