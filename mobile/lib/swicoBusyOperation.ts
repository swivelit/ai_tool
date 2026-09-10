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

  get isBusy(): boolean {
    return this.active !== null;
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
