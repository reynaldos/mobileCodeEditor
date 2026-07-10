import { useEffect, useState } from 'react'
import { fetchHealth, type Health } from './api.ts'
import { MessageList } from './components/MessageList.tsx'
import { PromptBox } from './components/PromptBox.tsx'
import { isSubscription } from './events.ts'
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
          {state.costUsd > 0 && <Cost usd={state.costUsd} subscription={isSubscription(state.apiKeySource)} />}
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

/**
 * `total_cost_usd` is what these tokens would cost at API rates. On a Pro/Max
 * subscription nothing is billed per token — usage draws on plan limits — so
 * rendering a bare "$0.239" reads as a bill it is not.
 */
function Cost({ usd, subscription }: { usd: number; subscription: boolean }): React.JSX.Element {
  if (!subscription) {
    return (
      <span className="cost" title="Billed per token against your Anthropic API key.">
        ${usd.toFixed(3)}
      </span>
    )
  }
  return (
    <span
      className="cost cost-plan"
      title={`≈$${usd.toFixed(3)} at API rates. Not charged — this session runs on your Claude subscription and draws on plan limits.`}
    >
      plan · ≈${usd.toFixed(3)}
    </span>
  )
}
