export type PlanState = 'pending' | 'in_progress' | 'completed' | 'blocked'
export type PlanItem = { id: string; description: string; state: PlanState }

export class PlanTracker {
  private items: PlanItem[] = []
  start(task: string): void {
    const lower = task.toLowerCase()
    const descriptions = lower.includes('test')
      ? ['Inspect repository and relevant instructions', 'Locate the implementation and tests', 'Apply a focused change', 'Run the relevant tests', 'Summarize changes and remaining issues']
      : ['Inspect the repository and relevant instructions', 'Make the requested change', 'Verify the result', 'Summarize the result']
    this.items = descriptions.map((description, index) => ({ id: `${index + 1}`, description, state: index === 0 ? 'in_progress' : 'pending' }))
  }
  restore(items: PlanItem[]): void { this.items = items.slice(0, 20).map(item => ({ id: item.id, description: item.description.slice(0, 240), state: item.state })) }
  advance(state: PlanState = 'completed'): void {
    const current = this.items.findIndex(item => item.state === 'in_progress')
    if (current >= 0) this.items[current].state = state
    if (state === 'completed' && current + 1 < this.items.length) this.items[current + 1].state = 'in_progress'
  }
  markBlocked(): void { this.advance('blocked') }
  get snapshot(): PlanItem[] { return this.items.map(item => ({ ...item })) }
  render(): string {
    if (!this.items.length) return 'No active plan.'
    return this.items.map(item => `${item.state === 'completed' ? '✓' : item.state === 'in_progress' ? '→' : item.state === 'blocked' ? '!' : '·'} ${item.description}`).join('\n')
  }
}
