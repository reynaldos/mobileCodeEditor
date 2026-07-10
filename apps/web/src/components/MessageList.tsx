import { useEffect, useRef } from 'react'
import type { Item } from '../events.ts'
import { ApprovalCard } from './ApprovalCard.tsx'

export function MessageList({ items }: { items: Item[] }): React.JSX.Element {
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [items.length])

  return (
    <div className="messages">
      {items.length === 0 && (
        <p className="empty">
          Nothing yet. Tell Claude what to do — it&rsquo;s working in your repo, and every
          edit comes back here for you to approve.
        </p>
      )}

      {items.map((item) => (
        <Row key={item.key} item={item} />
      ))}
      <div ref={bottom} />
    </div>
  )
}

function Row({ item }: { item: Item }): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return <div className="bubble user">{item.text}</div>

    case 'assistant':
      return <div className="bubble assistant">{item.text}</div>

    case 'approval':
      return <ApprovalCard item={item} />

    // One line, skimmable with a thumb. Not expandable JSON.
    case 'tool':
      return (
        <div className={`chip chip-${item.status}`}>
          <span className="chip-dot" />
          <span className="chip-name">{item.name}</span>
          <span className="chip-detail">{targetOf(item.input) ?? item.summary ?? ''}</span>
        </div>
      )

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

/** "Read src/api/routes.ts" reads better than a JSON blob. */
function targetOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>

  for (const field of ['file_path', 'path', 'pattern', 'command']) {
    const value = record[field]
    if (typeof value === 'string') return value
  }
  return undefined
}
