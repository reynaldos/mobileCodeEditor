import { useEffect, useState } from 'react'
import { fetchHealth, type Health } from './api.ts'
import { MessageList } from './components/MessageList.tsx'
import { PromptBox } from './components/PromptBox.tsx'
import { useEventStream, useKeyboardInset } from './useEventStream.ts'

const AGENT_LABEL: Record<string, string> = {
  idle: 'idle',
  thinking: 'working…',
  awaiting_approval: 'needs you',
  awaiting_input: 'ready',
  ended: 'ended',
}

export function App(): React.JSX.Element {
  const { state, connection } = useEventStream()
  const [health, setHealth] = useState<Health | undefined>()
  useKeyboardInset()

  useEffect(() => {
    void fetchHealth().then(setHealth).catch(() => undefined)
  }, [])

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="project">{health?.projectId ?? '…'}</span>
          <span className={`agent agent-${state.agent}`}>{AGENT_LABEL[state.agent]}</span>
        </div>
        <div className="header-right">
          {/* No cost display. Usage runs on a subscription, so a dollar figure is
              a meter reading rendered as an invoice. The log still records
              costUsd and apiKeySource; analytics is a query, not a header. */}
          <span className={`conn conn-${connection}`} title={connection} />
        </div>
      </header>

      {health && !health.agentReady && (
        <div className="banner">
          No <code>CLAUDE_CODE_OAUTH_TOKEN</code>. The log and stream work, but no agent will
          start. Run <code>claude setup-token</code> and put it in <code>.env</code>.
        </div>
      )}

      {connection === 'reconnecting' && (
        <div className="banner banner-quiet">
          Reconnecting… nothing is lost; the stream resumes where it stopped.
        </div>
      )}

      <MessageList items={state.items} projectPath={health?.projectPath} />
      <PromptBox />
    </div>
  )
}
