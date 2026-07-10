import { useEffect, useRef } from 'react'
import type { Item } from '../events.ts'
import { relativePath, targetOf } from '../paths.ts'
import { ApprovalCard } from './ApprovalCard.tsx'

interface Props {
  items: Item[]
  projectPath?: string
}

export function MessageList({ items, projectPath }: Props): React.JSX.Element {
  const bottom = useRef<HTMLDivElement>(null)

  const pendingKey = items.find((i) => i.kind === 'approval' && i.status === 'pending')?.key

  useEffect(() => {
    // A pending approval blocks the agent, so it must never sit below the fold.
    // Jump instantly rather than animating — a smooth scroll started during a
    // long assistant message lands short, and the card ends up unreachable.
    bottom.current?.scrollIntoView({ behavior: pendingKey ? 'auto' : 'smooth', block: 'end' })
  }, [items.length, pendingKey])

  return (
    <div className="messages">
      {items.length === 0 && (
        <p className="empty">
          Nothing yet. Tell Claude what to do — it&rsquo;s working in your repo, and every
          edit comes back here for you to approve.
        </p>
      )}

      {items.map((item) => (
        <Row key={item.key} item={item} projectPath={projectPath} />
      ))}
      <div ref={bottom} />
    </div>
  )
}

function Row({ item, projectPath }: { item: Item; projectPath?: string }): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return <div className="bubble user">{item.text}</div>

    case 'assistant':
      return <div className="bubble assistant">{item.text}</div>

    case 'approval':
      return <ApprovalCard item={item} projectPath={projectPath} />

    // One line, skimmable with a thumb. Not expandable JSON.
    case 'tool': {
      const target = targetOf(item.input)
      return (
        <div className={`chip chip-${item.status}`}>
          <span className="chip-dot" />
          <span className="chip-name">{item.name}</span>
          <span className="chip-detail">
            {target ? relativePath(target, projectPath) : (item.summary ?? '')}
          </span>
        </div>
      )
    }

    case 'turn':
      return (
        <div className="turn">
          <span>done</span>
          {item.costUsd !== undefined && <span className="cost">${item.costUsd.toFixed(4)}</span>}
        </div>
      )

    case 'ended':
      return (
        <div className={`ended ended-${item.reason}`}>
          session {item.reason}
          {item.message && <span className="ended-msg">{item.message}</span>}
        </div>
      )

    default:
      return null
  }
}
