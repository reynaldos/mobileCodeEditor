import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Does Claude still have this session's transcript on disk?
 *
 * This is the native-resume-vs-recap signal (PHASE-2.5, option C). Claude Code
 * stores each conversation as `<config>/projects/<cwd-slug>/<sessionId>.jsonl`.
 * Those files live in the container filesystem, NOT on the /data volume — so
 * within a run (or a `node --watch` restart, same fs) they're present and native
 * resume works; after a Fly redeploy (new machine) they're gone and we recap.
 *
 * Best-effort: if the layout differs or the store is missing, we return false and
 * fall back to the recap, which always works. Injectable so tests don't touch a
 * real home directory.
 *
 * VERIFY in production that this path is right (PHASE-2.5). If it's wrong we
 * simply always recap — safe, just lower fidelity — never broken.
 */
export type SessionExists = (claudeSessionId: string) => boolean

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

export const claudeSessionExists: SessionExists = (claudeSessionId) => {
  const projects = join(configDir(), 'projects')
  if (!existsSync(projects)) return false
  try {
    for (const slug of readdirSync(projects)) {
      if (existsSync(join(projects, slug, `${claudeSessionId}.jsonl`))) return true
    }
  } catch {
    /* unreadable → treat as absent */
  }
  return false
}
