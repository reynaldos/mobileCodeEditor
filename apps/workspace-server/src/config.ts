/**
 * The single place credentials are read. Not `process.env` at the call site.
 *
 * The day a container is provisioned for someone else it gets an
 * ANTHROPIC_API_KEY instead of a CLAUDE_CODE_OAUTH_TOKEN, and that should be a
 * change to this file rather than a hunt. See DECISIONS #14.
 */
import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

export interface Config {
  readonly port: number
  readonly host: string
  readonly dbPath: string
  /** Absolute path to the one project. A project is a directory; a picker is a feature. */
  readonly projectPath: string
  readonly projectId: string
  /** Absent is legal — the log, SSE, and debug injector all work without it. */
  readonly claudeToken: string | undefined
  readonly model: string | undefined
  readonly isDev: boolean
  /** The PWA build. Served from this same origin, which is why CORS exists only in dev. */
  readonly webDist: string
}

class ConfigError extends Error {}

function required(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) throw new ConfigError(`${name} is not set. Copy .env.example to .env and fill it in.`)
  return v
}

export function loadConfig(): Config {
  const projectPath = resolve(required('PROJECT_PATH'))

  let stat
  try {
    stat = statSync(projectPath)
  } catch {
    throw new ConfigError(`PROJECT_PATH does not exist: ${projectPath}`)
  }
  if (!stat.isDirectory()) throw new ConfigError(`PROJECT_PATH is not a directory: ${projectPath}`)

  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '127.0.0.1',
    dbPath: resolve(process.env.DB_PATH ?? './data/events.db'),
    projectPath,
    projectId: basename(projectPath),
    // Deliberately not required at boot. You can build and verify the whole SSE
    // and replay path before the agent exists — that's the Block 2 gate.
    claudeToken: process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || undefined,
    model: process.env.ANTHROPIC_MODEL?.trim() || undefined,
    isDev: process.env.NODE_ENV !== 'production',
    webDist: resolve(process.env.WEB_DIST ?? new URL('../../web/dist', import.meta.url).pathname),
  }
}

/**
 * Called when a session is about to start, not at boot.
 *
 * The token is read here but never passed to `query()` explicitly — the SDK
 * spawns the Claude Code CLI, which inherits `process.env`. This function is
 * the assertion that it's there.
 */
export function assertAgentCredentials(config: Config): void {
  if (!config.claudeToken) {
    throw new ConfigError(
      'CLAUDE_CODE_OAUTH_TOKEN is not set, so no agent session can start.\n' +
        'Mint one with `claude setup-token` and put it in .env. See docs/PHASE-0.md.',
    )
  }
}

/** Values scrubbed from every event payload before it is written. See log.ts. */
export function secretsOf(config: Config): string[] {
  return [config.claudeToken, process.env.GH_TOKEN, process.env.ANTHROPIC_API_KEY].filter(
    (s): s is string => typeof s === 'string' && s.length >= 8,
  )
}
