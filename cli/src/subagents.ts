/** Client-side bounds for protocol-v2, server-metered read-only subagents. */
export type ReadOnlySubagentTask = { id: string; task: string }

export function boundedSubagentTasks(tasks: ReadOnlySubagentTask[]): ReadOnlySubagentTask[] {
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 4) throw new Error('At most four read-only subagents may be active.')
  return tasks.map(item => {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(item.id) || !item.task || item.task.length > 2_000) throw new Error('Subagent tasks must be bounded and identified.')
    return { id: item.id, task: item.task.slice(0, 2_000) }
  })
}
