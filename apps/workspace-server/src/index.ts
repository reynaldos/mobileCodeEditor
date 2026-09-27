import { BuildTracker } from './build-tracker.ts'
import { loadConfig, secretsOf } from './config.ts'
import { openDb } from './db.ts'
import { acquireLock } from './lock.ts'
import { Github } from './github.ts'
import { EventLog } from './log.ts'
import { Notifier } from './notifier.ts'
import { Presence } from './presence.ts'
import { buildPreviewOriginServer } from './preview-origin-server.ts'
import { PreviewManager } from './preview-manager.ts'
import { PreviewTracker } from './preview-tracker.ts'
import { ProjectStore } from './projects.ts'
import { Pusher } from './push.ts'
import { PushStore } from './push-store.ts'
import { makeRedactor } from './redact.ts'
import { buildServer } from './server.ts'
import { SessionManager } from './session-manager.ts'
import { UploadStore } from './uploads.ts'

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
const uploads = new UploadStore(config.uploadsRoot)
const sessions = new SessionManager(log, config, projects, uploads)
const pushStore = new PushStore(db)
const pusher = new Pusher(pushStore, config.vapid)
const presence = new Presence()
const previewTracker = new PreviewTracker()
const previews = new PreviewManager(log, previewTracker, projects, presence, config)

// Live promises, generators, and builds died with the last process; the log did
// not. Recover interrupted sessions and builds into terminal events.
sessions.recoverOnBoot()
projects.recoverOnBoot()
// A dev server left running by the last process died with it (Phase 5) — same
// "the log said it was still going, but nothing is" recovery as builds/sessions.
previews.recoverOnBoot()
// An upload whose prompt was never sent has zero long-term value and would
// otherwise accumulate forever on a capacity-constrained volume. See UploadStore.
uploads.sweepOrphans(log.referencedImageIds())

// Turns log events into push notifications, on the same fan-out as SSE.
const notifier = new Notifier(log, pusher, presence)
notifier.start()

const app = await buildServer(config, {
  log,
  sessions,
  projects,
  builds,
  github,
  pushStore,
  pusher,
  presence,
  uploads,
  previews,
  previewTracker,
})
const previewOriginApp = buildPreviewOriginServer(config, previewTracker)

await Promise.all([
  app.listen({ port: config.port, host: config.host }),
  previewOriginApp.listen({ port: config.previewOriginPort, host: config.host }),
])
app.log.info(
  {
    projectsRoot: config.projectsRoot,
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
      // Kill the preview's detached dev server so a restart (SIGTERM from
      // `node --watch`, a deploy, a crash-restart) doesn't orphan it on the
      // preview port — an orphan there wedges the next preview with EADDRINUSE.
      previews.disposeActive()
      // Sessions first: stop() denies parked approvals so nothing hangs.
      await sessions.shutdown()
      await Promise.all([app.close(), previewOriginApp.close()])
      db.close()
      lock.release()
      process.exit(0)
    })()
  })
}
