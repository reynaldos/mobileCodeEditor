/**
 * Every path the agent reports is absolute — `/data/projects/<id>/app/page.tsx`.
 * The prefix is the same every time and tells you nothing; `app/page.tsx` fits on
 * a phone.
 *
 * The client no longer knows the absolute project path (the server doesn't leak
 * it), so we strip everything up to and including `/<projectId>/`.
 */
export function relativePath(absolute: string, projectId?: string): string {
  if (!projectId) return absolute
  const marker = `/${projectId}/`
  const i = absolute.indexOf(marker)
  if (i === -1) return absolute
  return absolute.slice(i + marker.length) || '.'
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
export function describeTool(tool: string, input: unknown, projectId?: string): string {
  const target = targetOf(input)
  if (!target) return `Claude wants to run ${tool}`
  if (tool === 'Bash') return `Claude wants to run: ${target}`
  return `${tool} ${relativePath(target, projectId)}`
}
