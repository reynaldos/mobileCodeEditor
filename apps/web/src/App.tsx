import { LEGACY_THREAD_ID } from '@mce/protocol'
import { useEffect, useState } from 'react'
import { fetchHealth, type Health } from './api.ts'
import { MessageList } from './components/MessageList.tsx'
import { NotificationsButton } from './components/NotificationsButton.tsx'
import { ProjectPicker } from './components/ProjectPicker.tsx'
import { PromptBox } from './components/PromptBox.tsx'
import { ThreadList } from './components/ThreadList.tsx'
import { type AgentState, viewOf } from './events.ts'
import { useEventStream, useKeyboardInset } from './useEventStream.ts'
import { useProjects } from './useProjects.ts'
import { useThreads } from './useThreads.ts'

const AGENT: Record<AgentState, { label: string; className: string }> = {
  idle: { label: 'idle', className: 'text-muted' },
  thinking: { label: 'working…', className: 'text-accent' },
  awaiting_approval: { label: 'needs you', className: 'text-warn' },
  awaiting_input: { label: 'ready', className: 'text-muted' },
  ended: { label: 'ended', className: 'text-muted' },
}

const CONNECTION: Record<string, string> = {
  connecting: 'bg-muted',
  live: 'bg-add',
  reconnecting: 'bg-warn animate-pulse-dot',
}

/** Which overlay is up, if any. null = the conversation. */
type Overlay = 'projects' | 'threads' | null

export function App(): React.JSX.Element {
  const { state, connection } = useEventStream()
  const projectsState = useProjects()
  const { projects, activeId: activeProjectId } = projectsState
  const { threads, activeThreadId, setActiveThreadId, refresh: refreshThreads } = useThreads(activeProjectId)
  const [health, setHealth] = useState<Health | undefined>()
  const [overlay, setOverlay] = useState<Overlay>(null)
  useKeyboardInset()

  useEffect(() => {
    void fetchHealth().then(setHealth).catch(() => undefined)
  }, [])

  // A project_created event → refetch the project list.
  useEffect(() => {
    void projectsState.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.created.length])

  // Any new conversation activity → the thread list may have reordered / grown.
  useEffect(() => {
    void refreshThreads()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lastSeq])

  const activeThread = threads.find((t) => t.id === activeThreadId)
  const isLegacy = activeThreadId === LEGACY_THREAD_ID || activeThread?.legacy === true
  const view = viewOf(state, activeThreadId)
  const agent = AGENT[view.agent]
  const projectName = projects.find((p) => p.id === activeProjectId)?.name

  return (
    // `app` owns 100dvh and the keyboard inset. See styles.css.
    <div className="app flex flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-panel px-3.5 pb-2.5 pt-[calc(10px+env(safe-area-inset-top,0px))]">
        <button
          className="flex min-w-0 items-center gap-1.5"
          onClick={() => setOverlay(activeProjectId ? 'threads' : 'projects')}
          title="Projects and threads"
        >
          <span className="truncate font-semibold">{projectName ?? 'Projects'}</span>
          {activeThread && <span className="shrink-0 text-muted">›</span>}
          {activeThread && (
            <span className="max-w-[40vw] truncate text-[13px] text-muted">
              {activeThread.legacy ? 'Earlier' : activeThread.title}
            </span>
          )}
          <span className={`shrink-0 text-xs ${agent.className}`}>{agent.label}</span>
        </button>

        <div className="flex shrink-0 items-center gap-2.5">
          <NotificationsButton />
          <span className={`size-2 shrink-0 rounded-full ${CONNECTION[connection]}`} title={connection} />
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

      <MessageList items={view.items} projectId={activeProjectId ?? undefined} />

      <PromptBox
        projectId={activeProjectId}
        threadId={isLegacy ? null : activeThreadId}
        disabledReason={
          !activeProjectId
            ? 'Pick a project'
            : !activeThreadId
              ? 'Pick or start a thread'
              : isLegacy
                ? 'This is read-only — start a new thread to continue'
                : undefined
        }
      />

      {overlay === 'projects' && (
        <ProjectPicker
          projects={projects}
          activeId={activeProjectId}
          failed={state.failed}
          onSelect={(id) => {
            projectsState.setActiveId(id)
            setOverlay('threads')
          }}
          onClose={() => setOverlay(null)}
        />
      )}

      {overlay === 'threads' && activeProjectId && (
        <ThreadList
          projectId={activeProjectId}
          projectName={projectName ?? activeProjectId}
          threads={threads}
          activeThreadId={activeThreadId}
          onSelect={(id) => {
            setActiveThreadId(id)
            setOverlay(null)
          }}
          onBack={() => setOverlay('projects')}
          onCreated={(id) => {
            void refreshThreads()
            setActiveThreadId(id)
            setOverlay(null)
          }}
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
