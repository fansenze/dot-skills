/** Select records before loading details or grouping them for presentation. */
export const ACTIVE_TASK_STATES = new Set(['queued', 'executing', 'blocked', 'awaiting_verification']);
const updated = task => BigInt(Date.parse(task.updated_at)) * 1000n +
  BigInt((task.updated_at.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? '').padEnd(6, '0').slice(3, 6));
export function selectTaskList(tasks, {all = false, status} = {}) {
  const selected = tasks.filter(task => status ? task.status === status : all || ACTIVE_TASK_STATES.has(task.status));
  selected.sort((a, b) => {
    const delta = updated(b) - updated(a);
    return delta < 0n ? -1 : delta > 0n ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return all ? selected : selected.slice(0, 10);
}
