import type { Workspace } from './workspace.js'
import type { AgentContext } from './context.js'

export type SubagentTask = { id: string; task: string }
export type SubagentResult = { id: string; status: 'completed' | 'failed' | 'cancelled'; summary: string }

/** Stage 2 deliberately keeps subagents read-only and depth-one. The root run owns all mutations. */
export class ReadOnlySubagents {
  private active = 0
  constructor(private readonly workspace: Workspace, private readonly maxActive = 4) {}
  async run(tasks: SubagentTask[], context: AgentContext, signal?: AbortSignal): Promise<SubagentResult[]> {
    if (tasks.length > this.maxActive) throw new Error(`At most ${this.maxActive} subagents may be active.`)
    return Promise.all(tasks.map(async task => {
      if (signal?.aborted) return { id: task.id, status: 'cancelled', summary: 'Parent run was cancelled.' }
      this.active += 1
      try {
        const files = await this.workspace.searchText(task.task.slice(0, 512), 20).catch(() => [])
        return { id: task.id, status: 'completed', summary: `${task.task}\nRelevant bounded local matches:\n${files.join('\n') || '(none)'}\nRepository: ${context.repository.root}` }
      } catch (error) { return { id: task.id, status: 'failed', summary: error instanceof Error ? error.message : 'Subagent inspection failed.' } }
      finally { this.active -= 1 }
    }))
  }
  get activeCount(): number { return this.active }
  async inspect(tasks: SubagentTask[], signal?: AbortSignal): Promise<SubagentResult[]> {
    if (tasks.length > this.maxActive) throw new Error(`At most ${this.maxActive} subagents may be active.`)
    return Promise.all(tasks.map(async task => {
      if (signal?.aborted) return { id: task.id, status: 'cancelled', summary: 'Parent run was cancelled.' }
      const matches = await this.workspace.searchText(task.task.slice(0, 512), 20).catch(() => [])
      return { id: task.id, status: 'completed', summary: `${task.task}\n${matches.join('\n') || '(no bounded local matches)'}` }
    }))
  }
}
