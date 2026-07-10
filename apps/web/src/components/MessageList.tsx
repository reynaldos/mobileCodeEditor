import { useEffect, useRef } from 'react'
import type { Item } from '../events.ts'
import { relativePath, targetOf } from '../paths.ts'
import { ApprovalCard } from './ApprovalCard.tsx'

interface Props {
  items: Item[]
  projectPath?: string
}

const DOT: Record<'running' | 'ok' | 'error', string> = {
  running: 'bg-accent animate-pulse-dot',
  ok: 'bg-add',
  error: 'bg-del',
}

const SEPARATOR = 'flex justify-center gap-2 py-1 text-[11px] uppercase tracking-[0.08em] text-muted'

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
    // `messages` carries the flex-shrink guard in styles.css. Do not rename it.
    <div className="messages flex flex-1 flex-col gap-2.5 overflow-y-auto p-3.5">
      {items.length === 0 && (
        <p className="m-auto max-w-[30ch] text-center text-muted">
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
      return (
        // [overflow-wrap:anywhere] so an unbroken 200-char path cannot widen the
        // bubble past the viewport. `break-words` is not enough for a string with
        // no break opportunities at all.
        <div className="max-w-[85%] self-end whitespace-pre-wrap rounded-[14px] rounded-br-[4px] bg-accent px-3 py-2.5 text-[#06101f] [overflow-wrap:anywhere]">
          {item.text}
        </div>
      )

    case 'assistant':
      return (
        <div className="whitespace-pre-wrap rounded-[14px] rounded-bl-[4px] border border-line bg-panel px-3 py-2.5 [overflow-wrap:anywhere]">
          {item.text}
        </div>
      )

    case 'approval':
      return <ApprovalCard item={item} projectPath={projectPath} />

    // One line, skimmable with a thumb. Not expandable JSON.
    case 'tool': {
      const target = targetOf(item.input)
      return (
        <div className="flex min-w-0 items-center gap-2 px-0.5 py-1 text-xs text-muted">
          <span className={`size-1.5 shrink-0 rounded-full ${DOT[item.status]}`} />
          <span className="shrink-0 text-fg">{item.name}</span>
          <span className="truncate text-left font-mono">
            {target ? relativePath(target, projectPath) : (item.summary ?? '')}
          </span>
        </div>
      )
    }

    case 'turn':
      return <div className={SEPARATOR}>done</div>

    case 'ended':
      return (
        <div className={`${SEPARATOR} ${item.reason === 'complete' ? '' : 'text-warn'}`}>
          session {item.reason}
          {item.message && <span className="normal-case tracking-normal">{item.message}</span>}
        </div>
      )

    default:
      return null
  }
}
