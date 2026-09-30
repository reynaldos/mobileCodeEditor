import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Reads the project's own CLAUDE.md, if it has one.
 *
 * The SDK's built-in CLAUDE.md loading is gated behind `settingSources`
 * including `'project'` — but that source also loads the project's
 * `.claude/settings.json` (permissions, hooks, MCP servers), and a project
 * here is whatever repo the user opened, not code we control. A hook or a
 * pre-approved permission rule in a stranger's repo would run/bypass cards
 * with no card of its own. So `AgentSession` keeps `settingSources: []` and
 * this reads just the CLAUDE.md text to fold into the system prompt instead.
 */
export function readProjectClaudeMd(projectPath: string): string | undefined {
  try {
    const text = readFileSync(join(projectPath, 'CLAUDE.md'), 'utf8').trim()
    return text.length > 0 ? text : undefined
  } catch {
    return undefined
  }
}
