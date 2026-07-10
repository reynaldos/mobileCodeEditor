/**
 * Every path the agent reports is absolute and starts with the project root,
 * which is the same 40 characters every time and tells you nothing.
 *
 * `app/(app)/settings/page.tsx` fits on a phone. The absolute path does not.
 */
export function relativePath(absolute: string, projectPath?: string): string {
  if (!projectPath || !absolute.startsWith(projectPath)) return absolute

  const rest = absolute.slice(projectPath.length)
  // A bare startsWith would turn `/repo-old/x.ts` into `-old/x.ts`. The next
  // character has to be a separator, or there is no next character at all.
  if (rest === '') return '.'
  if (!rest.startsWith('/')) return absolute

  return rest.slice(1) || '.'
}

/** Pull the first path-ish field out of a tool input, for a chip or a title. */
export function targetOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>

  for (const field of ['file_path', 'path', 'notebook_path', 'pattern', 'command']) {
    const value = record[field]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

/** "Edit app/(app)/settings/page.tsx" — used when the SDK gives us no title. */
export function describeTool(tool: string, input: unknown, projectPath?: string): string {
  const target = targetOf(input)
  if (!target) return `Claude wants to run ${tool}`
  if (tool === 'Bash') return `Claude wants to run: ${target}`
  return `${tool} ${relativePath(target, projectPath)}`
}
