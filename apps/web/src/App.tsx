import { LEGACY_THREAD_ID } from '@mce/protocol'
import { ChevronDown, Files, GitBranch, History, KeyRound, MessageCirclePlus, MonitorPlay } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { deleteThread, fetchHealth, type Health, renameThread } from './api.ts'
import { ActionsMenu } from './components/ActionsMenu.tsx'
import { BuildModal } from './components/BuildModal.tsx'
import { EnvDrawer } from './components/EnvDrawer.tsx'
import { MessageList } from './components/MessageList.tsx'
import { NotificationsButton } from './components/NotificationsButton.tsx'
import { PreviewDrawer, PREVIEW_PEEK } from './components/PreviewDrawer.tsx'
import { ProjectPicker } from './components/ProjectPicker.tsx'
import { PromptBox } from './components/PromptBox.tsx'
import { StatusDot } from './components/StatusDot.tsx'
import { ThreadsHome } from './components/ThreadsHome.tsx'
import { threadStatus, viewOf } from './events.ts'
import { useBuilds } from './useBuilds.ts'
import { useEventStream, useKeyboardInset } from './useEventStream.ts'
import { usePreview } from './usePreview.ts'
import { useProjects } from './useProjects.ts'
import { useThreads } from './useThreads.ts'

/**
 * CodeMirror 6 (plus its language packages) is the single heaviest thing
 * this app bundles — over 1MB minified, all for a drawer most sessions never
 * open. Loaded as its own chunk, on first Explorer/Source-control open, so
 * everyone else's initial PWA load stays light.
 */
const ExplorerDrawer = lazy(() => import('./components/ExplorerDrawer.tsx').then((m) => ({ default: m.ExplorerDrawer })))

/** Which overlay is up, if any. null = the conversation (or the thread list — see `activeThreadId`). */
type Overlay = 'projects' | null

export function App(): React.JSX.Element {
  const { state, connection } = useEventStream()
  const projectsState = useProjects()
  const { projects, activeId: activeProjectId } = projectsState
  const { threads, loading: threadsLoading, refresh: refreshThreads } = useThreads(activeProjectId)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [health, setHealth] = useState<Health | undefined>()
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [envOpen, setEnvOpen] = useState(false)
  // The explorer's target project persists through a close (mirrors `usePreview`'s
  // `projectId`) so the drawer can play its close animation instead of unmounting
  // instantly — and so it can be opened for a project row that isn't the active
  // one (PHASE-3.md design call 3: browse-without-switching).
  const [explorerProjectId, setExplorerProjectId] = useState<string | null>(null)
  const [explorerView, setExplorerView] = useState<'tree' | 'source-control'>('tree')
  // A file to open on the Explorer's file view (from a thread changes card's "View file"), or null.
  const [explorerFile, setExplorerFile] = useState<string | null>(null)
  const [explorerOpen, setExplorerOpen] = useState(false)
  const openExplorer = useCallback((projectId: string, view: 'tree' | 'source-control') => {
    setExplorerProjectId(projectId)
    setExplorerView(view)
    setExplorerFile(null)
    setExplorerOpen(true)
  }, [])
  const openExplorerFile = useCallback((projectId: string, path: string) => {
    setExplorerProjectId(projectId)
    setExplorerView('tree')
    setExplorerFile(path)
    setExplorerOpen(true)
  }, [])
  const builds = useBuilds(state)
  const preview = usePreview(state.preview)
  useKeyboardInset()

  const startNewThread = useCallback(() => setActiveThreadId(crypto.randomUUID()), [])

  useEffect(() => {
    void fetchHealth().then(setHealth).catch(() => undefined)
  }, [])

  // A project_created event → refetch the project list.
  useEffect(() => {
    void projectsState.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.created.length])

  // A project_removed event (this tab's own removal, or another tab/device's)
  // → refetch. `refresh` already falls back off an active id that's gone.
  useEffect(() => {
    void projectsState.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.removed.length])

  // New conversation activity can include a branch change (e.g. the agent runs
  // `git checkout`) — refetch the project list so the header's branch subtitle
  // stays live instead of only updating on the next full reload.
  useEffect(() => {
    void projectsState.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lastSeq])

  // Selecting (or restoring) a project lands on its thread list (`activeThreadId
  // === null` renders <ThreadsHome> below) — except a project with no threads
  // yet has nothing to list, so it skips straight to a fresh one.
  useEffect(() => {
    setActiveThreadId(null)
  }, [activeProjectId])

  useEffect(() => {
    if (activeProjectId && !threadsLoading && threads.length === 0 && activeThreadId === null) startNewThread()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, threadsLoading, threads.length])

  // New conversation activity → the thread list may have reordered / grown.
  useEffect(() => {
    void refreshThreads()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lastSeq])

  const isLegacy = activeThreadId === LEGACY_THREAD_ID

  async function onRenameThread(threadId: string, title: string): Promise<void> {
    if (!activeProjectId) return
    await renameThread(activeProjectId, threadId, title).catch(() => undefined)
    await refreshThreads()
  }

  async function onDeleteThread(threadId: string): Promise<void> {
    if (!activeProjectId) return
    await deleteThread(activeProjectId, threadId).catch(() => undefined)
    // Back to the thread list, not straight to a new thread — if that was the
    // last one, the effect above starts a fresh thread for you anyway.
    if (threadId === activeThreadId) setActiveThreadId(null)
    await refreshThreads()
  }
  const view = viewOf(state, activeThreadId)
  const activeProject = projects.find((p) => p.id === activeProjectId)
  const projectName = activeProject?.name
  // Every thread the event log has seen gets a live `agent` projection (see
  // events.ts), not just the active one — so the thread list can badge threads
  // still working / needing a decision without any extra fetching.
  const statusOf = useCallback((threadId: string) => threadStatus(state.byThread[threadId]?.agent), [state.byThread])
  // While a project sets up, the build modal replaces the thread — leaving the
  // header usable so you can switch away and come back to it, still building.
  const showBuild = activeProjectId !== null && builds.shouldShow(activeProjectId)
  // No thread picked yet (just landed on the project, or backed out via
  // "Previous threads") → the thread list, not a conversation. Building takes
  // priority — a project that's still cloning has no threads worth showing.
  const showThreadsHome = activeProjectId !== null && activeThreadId === null && !showBuild

  return (
    // `app` owns 100dvh and the keyboard inset. See styles.css. When a preview is
    // peeked (open but lowered), `--preview-peek` reserves room at the bottom so
    // the peeked bar doesn't sit on top of the prompt box.
    <div
      className="app flex flex-col"
      style={
        { '--preview-peek': preview.projectId !== null && !preview.raised ? PREVIEW_PEEK : '0px' } as React.CSSProperties
      }
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-panel px-3.5 pb-2.5 pt-[calc(10px+env(safe-area-inset-top,0px))]">
        <button className="flex min-w-0 flex-col items-start" onClick={() => setOverlay('projects')} title="Switch project">
          <span className="flex min-w-0 items-center gap-1.5">
            {activeProjectId && <StatusDot connection={connection} />}
            <span className="truncate font-semibold">{projectName ?? 'Projects'}</span>
            <ChevronDown className="size-4 shrink-0 text-muted" />
          </span>
          {activeProject?.branch && <span className="truncate text-xs text-muted">{activeProject.branch}</span>}
        </button>

        <div className="flex shrink-0 items-center gap-2.5">
          {activeProjectId && (
            <ActionsMenu
              actions={[
                {
                  key: 'threads',
                  label: 'Previous threads',
                  icon: History,
                  onClick: () => setActiveThreadId(null),
                },
                {
                  key: 'new-thread',
                  label: 'New thread',
                  icon: MessageCirclePlus,
                  onClick: () => {
                    startNewThread()
                    setOverlay(null)
                  },
                },
                {
                  key: 'env',
                  label: 'Environment (.env)',
                  icon: KeyRound,
                  onClick: () => setEnvOpen(true),
                },
                {
                  key: 'explorer',
                  label: 'Explorer',
                  icon: Files,
                  onClick: () => activeProjectId && openExplorer(activeProjectId, 'tree'),
                },
                {
                  key: 'source-control',
                  label: 'Source control',
                  icon: GitBranch,
                  onClick: () => activeProjectId && openExplorer(activeProjectId, 'source-control'),
                },
                ...(activeProject?.previewSupported
                  ? [
                      {
                        key: 'preview',
                        label: 'Preview',
                        icon: MonitorPlay,
                        onClick: () => activeProjectId && preview.request(activeProjectId),
                      },
                    ]
                  : []),
              ]}
            />
          )}
          <NotificationsButton />
        </div>
      </header>

      {health && !health.agentReady && (
        <Banner tone="warn">
          No <Code>CLAUDE_CODE_OAUTH_TOKEN</Code>. The log and stream work, but no agent will
          start. Run <Code>claude setup-token</Code> and put it in <Code>.env</Code>.
        </Banner>
      )}

      {connection === 'reconnecting' && (
        <Banner tone="quiet">Reconnecting… nothing is lost; the stream resumes where it stopped.</Banner>
      )}

      {showBuild && activeProjectId ? (
        <BuildModal
          projectId={activeProjectId}
          projectName={projectName ?? activeProjectId}
          onOpen={() => builds.dismiss(activeProjectId)}
          onBack={() => {
            builds.dismiss(activeProjectId)
            projectsState.setActiveId(null)
            setOverlay('projects')
          }}
        />
      ) : showThreadsHome && activeProjectId ? (
        <ThreadsHome
          projectId={activeProjectId}
          threads={threads}
          loading={threadsLoading}
          statusOf={statusOf}
          onSelect={(id) => setActiveThreadId(id)}
          onRename={(id, title) => void onRenameThread(id, title)}
          onDelete={(id) => void onDeleteThread(id)}
          onStarted={(id) => setActiveThreadId(id)}
        />
      ) : (
        <>
          <MessageList
            items={view.items}
            projectId={activeProjectId ?? undefined}
            agent={view.agent}
            onViewFile={activeProjectId ? (path) => openExplorerFile(activeProjectId, path) : undefined}
          />

          <PromptBox
            projectId={activeProjectId}
            threadId={isLegacy ? null : activeThreadId}
            disabledReason={
              !activeProjectId
                ? 'Pick a project'
                : isLegacy
                  ? 'This is a previous conversation — start a new thread to continue'
                  : undefined
            }
          />
        </>
      )}

      {overlay === 'projects' && (
        <ProjectPicker
          projects={projects}
          activeId={activeProjectId}
          failed={state.failed}
          onSelect={(id) => {
            projectsState.setActiveId(id) // the effects above land on its thread list (or a fresh thread if it has none)
            setOverlay(null)
          }}
          onStarted={(projectId) => {
            builds.start(projectId)
            projectsState.setActiveId(projectId)
            setOverlay(null)
          }}
          onRemoved={() => void projectsState.refresh()}
          onClose={() => setOverlay(null)}
          onOpenExplorer={(id) => {
            openExplorer(id, 'tree')
            setOverlay(null)
          }}
        />
      )}

      {activeProjectId && <EnvDrawer projectId={activeProjectId} open={envOpen} onOpenChange={setEnvOpen} />}

      {explorerProjectId && (
        <Suspense fallback={null}>
          <ExplorerDrawer
            key={explorerProjectId}
            projectId={explorerProjectId}
            projectName={projects.find((p) => p.id === explorerProjectId)?.name ?? explorerProjectId}
            branch={projects.find((p) => p.id === explorerProjectId)?.branch}
            initialView={explorerView}
            initialFile={explorerFile ?? undefined}
            open={explorerOpen}
            onOpenChange={setExplorerOpen}
            onGitChange={() => void projectsState.refresh()}
          />
        </Suspense>
      )}

      {/* Mounted regardless of the active project — a peeked preview for a project you've since
          navigated away from in the main nav stays alive and visible, per PHASE-5.md design call 7. */}
      <PreviewDrawer preview={preview} projects={projects} />
    </div>
  )
}

function Banner({ tone, children }: { tone: 'warn' | 'quiet'; children: React.ReactNode }): React.JSX.Element {
  const skin = tone === 'warn' ? 'bg-[#2a2210] text-[#e8d9a8]' : 'bg-panel-2 text-muted'
  return <div className={`shrink-0 border-b border-line px-3.5 py-2.5 text-[13px] ${skin}`}>{children}</div>
}

const Code = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <code className="rounded bg-black/25 px-1 py-px">{children}</code>
)
