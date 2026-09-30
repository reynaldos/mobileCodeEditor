import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk'

/**
 * Where locally-installed plugins live: one subdirectory per plugin, each with
 * its own `.claude-plugin/plugin.json` manifest.
 *
 * Deliberately NOT settings.json-based (`enabledPlugins`/`extraKnownMarketplaces`)
 * — that would need `settingSources` to include `'project'` or `'user'`, and
 * `AgentSession` keeps that off (see session.ts). A fixed on-disk directory
 * gives chat a way to install plugins (just clone into it — Bash already has
 * write access) without touching settings.json trust/permission plumbing.
 */
export function localPluginsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
  return join(configDir, 'plugins-local')
}

/**
 * Every plugin directory found under `dir`, as SDK plugin configs. Re-scanned
 * fresh at each session start — a plugin cloned mid-conversation takes effect
 * on the next new chat thread, not the current one.
 */
export function discoverLocalPlugins(dir: string = localPluginsDir()): SdkPluginConfig[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory()
      } catch {
        return false
      }
    })
    .map((name) => ({ type: 'local', path: join(dir, name) }))
}
