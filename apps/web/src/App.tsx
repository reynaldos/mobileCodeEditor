import { useEffect, useState } from 'react'
import { fetchHealth, type Health } from './api.ts'
import { MessageList } from './components/MessageList.tsx'
import { NewConversationButton } from './components/NewConversationButton.tsx'
import { NotificationsButton } from './components/NotificationsButton.tsx'
import { PromptBox } from './components/PromptBox.tsx'
import type { AgentState } from './events.ts'
import { useEventStream, useKeyboardInset } from './useEventStream.ts'

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

export function App(): React.JSX.Element {
  const { state, connection } = useEventStream()
  const [health, setHealth] = useState<Health | undefined>()
  useKeyboardInset()

  useEffect(() => {
    void fetchHealth().then(setHealth).catch(() => undefined)
  }, [])

  const agent = AGENT[state.agent]

  return (
    // `app` owns 100dvh and the keyboard inset. See styles.css.
    <div className="app flex flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-panel px-3.5 pb-2.5 pt-[calc(10px+env(safe-area-inset-top,0px))]">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="truncate font-semibold">{health?.projectId ?? '…'}</span>
          <span className={`text-xs ${agent.className}`}>{agent.label}</span>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {/* No cost display. Usage runs on a subscription, so a dollar figure is
              a meter reading rendered as an invoice. The log still records
              costUsd and apiKeySource; analytics is a query, not a header. */}
          <NotificationsButton />
          <NewConversationButton
            busy={state.agent === 'thinking' || state.agent === 'awaiting_approval'}
          />
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
        <Banner tone="quiet">
          Reconnecting… nothing is lost; the stream resumes where it stopped.
        </Banner>
      )}

      <MessageList items={state.items} projectPath={health?.projectPath} />
      <PromptBox />
    </div>
  )
}

function Banner({
  tone,
  children,
}: {
  tone: 'warn' | 'quiet'
  children: React.ReactNode
}): React.JSX.Element {
  const skin = tone === 'warn' ? 'bg-[#2a2210] text-[#e8d9a8]' : 'bg-panel-2 text-muted'
  return <div className={`shrink-0 border-b border-line px-3.5 py-2.5 text-[13px] ${skin}`}>{children}</div>
}

const Code = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <code className="rounded bg-black/25 px-1 py-px">{children}</code>
)
