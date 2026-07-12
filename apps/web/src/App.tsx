import { LEGACY_THREAD_ID } from '@mce/protocol'
import { ChevronDown, History, KeyRound, MessageCirclePlus, MonitorPlay } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { deleteThread, fetchHealth, type Health, renameThread } from './api.ts'
import { BuildModal } from './components/BuildModal.tsx'
import { EnvDrawer } from './components/EnvDrawer.tsx'
import { MessageList } from './components/MessageList.tsx'
import { NotificationsButton } from './components/NotificationsButton.tsx'
import { PreviewDrawer } from './components/PreviewDrawer.tsx'
import { ProjectPicker } from './components/ProjectPicker.tsx'
import { PromptBox } from './components/PromptBox.tsx'
import { ThreadList } from './components/ThreadList.tsx'
import { viewOf } from './events.ts'
import { useBuilds } from './useBuilds.ts'
import { useEventStream, useKeyboardInset } from './useEventStream.ts'
import { usePreview } from './usePreview.ts'
import { useProjects } from './useProjects.ts'
import { useThreads } from './useThreads.ts'

/** Which overlay is up, if any. null = the conversation. */
type Overlay = 'projects' | 'threads' | null

export function App(): React.JSX.Element {
  const { state, connection } = useEventStream()
  const projectsState = useProjects()
  const { projects, activeId: activeProjectId } = projectsState
  const { threads, refresh: refreshThreads } = useThreads(activeProjectId)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [health, setHealth] = useState<Health | undefined>()
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [envOpen, setEnvOpen] = useState(false)
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

  // Selecting (or restoring) a project starts a fresh thread by default; you
  // reach previous threads through the history icon.
  useEffect(() => {
    if (activeProjectId) startNewThread()
    else setActiveThreadId(null)
  }, [activeProjectId, startNewThread])

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
    if (threadId === activeThreadId) startNewThread()
    await refreshThreads()
  }
  const view = viewOf(state, activeThreadId)
  const activeProject = projects.find((p) => p.id === activeProjectId)
  const projectName = activeProject?.name
  // While a project sets up, the build modal replaces the thread — leaving the
  // header usable so you can switch away and come back to it, still building.
  const showBuild = activeProjectId !== null && builds.shouldShow(activeProjectId)

  return (
    // `app` owns 100dvh and the keyboard inset. See styles.css.
    <div className="app flex flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-panel px-3.5 pb-2.5 pt-[calc(10px+env(safe-area-inset-top,0px))]">
        <button className="flex min-w-0 flex-col items-start" onClick={() => setOverlay('projects')} title="Switch project">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-semibold">{projectName ?? 'Projects'}</span>
            <ChevronDown className="size-4 shrink-0 text-muted" />
          </span>
          {activeProject?.branch && <span className="truncate text-xs text-muted">{activeProject.branch}</span>}
        </button>

        <div className="flex shrink-0 items-center gap-2.5">
          {activeProjectId && (
            <>
              <button
                className="flex items-center text-muted"
                title="Previous threads"
                aria-label="Previous threads"
                onClick={() => setOverlay((o) => (o === 'threads' ? null : 'threads'))}
              >
                <History className="size-[18px]" />
              </button>
              <button
                className="flex items-center text-muted"
                title="New thread"
                aria-label="New thread"
                onClick={() => {
                  startNewThread()
                  setOverlay(null)
                }}
              >
                <MessageCirclePlus className="size-[18px]" />
              </button>
              <button
                className="flex items-center text-muted"
                title="Environment (.env)"
                aria-label="Environment"
                onClick={() => setEnvOpen(true)}
              >
                <KeyRound className="size-[18px]" />
              </button>
              {activeProject?.previewSupported && (
                <button
                  className="flex items-center text-muted"
                  title="Preview"
                  aria-label="Preview"
                  onClick={() => activeProjectId && preview.request(activeProjectId)}
                >
                  <MonitorPlay className="size-[18px]" />
                </button>
              )}
            </>
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
      ) : (
        <>
          <MessageList items={view.items} projectId={activeProjectId ?? undefined} agent={view.agent} />

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
            projectsState.setActiveId(id) // the effect above starts a fresh thread
            setOverlay(null)
          }}
          onStarted={(projectId) => {
            builds.start(projectId)
            projectsState.setActiveId(projectId)
            setOverlay(null)
          }}
          onClose={() => setOverlay(null)}
        />
      )}

      {activeProjectId && <EnvDrawer projectId={activeProjectId} open={envOpen} onOpenChange={setEnvOpen} />}

      {/* Mounted regardless of the active project — a peeked preview for a project you've since
          navigated away from in the main nav stays alive and visible, per PHASE-5.md design call 7. */}
      <PreviewDrawer preview={preview} projects={projects} />

      {overlay === 'threads' && activeProjectId && (
        <ThreadList
          threads={threads}
          activeThreadId={activeThreadId}
          onSelect={(id) => {
            setActiveThreadId(id)
            setOverlay(null)
          }}
          onRename={(id, title) => void onRenameThread(id, title)}
          onDelete={(id) => void onDeleteThread(id)}
          onClose={() => setOverlay(null)}
        />
      )}
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
