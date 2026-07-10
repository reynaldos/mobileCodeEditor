import { loadConfig, secretsOf } from './config.ts'
import { openDb } from './db.ts'
import { acquireLock } from './lock.ts'
import { EventLog } from './log.ts'
import { makeRedactor } from './redact.ts'
import { buildServer } from './server.ts'
import { SessionManager } from './session-manager.ts'

const config = loadConfig()

// Before anything touches the log. Boot recovery is about to declare every open
// session "interrupted" — it must be the only process able to say so.
// Waits briefly for a predecessor to exit, which is what `node --watch` needs.
const lock = await acquireLock(`${config.dbPath}.lock`)

const db = openDb(config.dbPath)
const log = new EventLog(db, makeRedactor(secretsOf(config)))
const sessions = new SessionManager(log, config)

// Live promises and generators died with the last process; the log did not.
sessions.recoverOnBoot()

const app = await buildServer(config, log, sessions)

await app.listen({ port: config.port, host: config.host })
app.log.info(
  { project: config.projectPath, lastSeq: log.lastSeq(), agentReady: Boolean(config.claudeToken) },
  config.claudeToken
    ? 'workspace server ready'
    : 'workspace server ready (no CLAUDE_CODE_OAUTH_TOKEN — log and SSE work, agent will not start)',
)

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info('shutting down')
    void (async () => {
      // Sessions first: stop() denies parked approvals so nothing hangs.
      await sessions.shutdown()
      await app.close()
      db.close()
      lock.release()
      process.exit(0)
    })()
  })
}
