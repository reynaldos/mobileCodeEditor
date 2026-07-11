import { BuildTracker } from './build-tracker.ts'
import { loadConfig, secretsOf } from './config.ts'
import { openDb } from './db.ts'
import { acquireLock } from './lock.ts'
import { Github } from './github.ts'
import { EventLog } from './log.ts'
import { Notifier } from './notifier.ts'
import { ProjectStore } from './projects.ts'
import { Pusher } from './push.ts'
import { PushStore } from './push-store.ts'
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
// gh authenticates from GH_TOKEN in the container. Absent → GitHub features off,
// and the picker degrades to plain URL paste + local create.
const github = process.env.GH_TOKEN ? new Github() : undefined
const builds = new BuildTracker()
const projects = new ProjectStore(config.projectsRoot, log, github, builds)
const sessions = new SessionManager(log, config, projects)
const pushStore = new PushStore(db)
const pusher = new Pusher(pushStore, config.vapid)

// Live promises, generators, and builds died with the last process; the log did
// not. Recover interrupted sessions and builds into terminal events.
sessions.recoverOnBoot()
projects.recoverOnBoot()

// Turns log events into push notifications, on the same fan-out as SSE.
const notifier = new Notifier(log, pusher)
notifier.start()

const app = await buildServer(config, { log, sessions, projects, builds, github, pushStore, pusher })

await app.listen({ port: config.port, host: config.host })
app.log.info(
  {
    project: config.projectPath,
    lastSeq: log.lastSeq(),
    agentReady: Boolean(config.claudeToken),
    pushReady: pusher.enabled,
  },
  config.claudeToken
    ? 'workspace server ready'
    : 'workspace server ready (no CLAUDE_CODE_OAUTH_TOKEN — log and SSE work, agent will not start)',
)
if (!pusher.enabled) {
  app.log.warn('push disabled — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT to enable')
}

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info('shutting down')
    void (async () => {
      notifier.stop()
      // Sessions first: stop() denies parked approvals so nothing hangs.
      await sessions.shutdown()
      await app.close()
      db.close()
      lock.release()
      process.exit(0)
    })()
  })
}
