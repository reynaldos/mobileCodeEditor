import { useState } from 'react'
import { ApiError, decideApproval } from '../api.ts'
import { diffSubjectOf } from '../diff.ts'
import type { Item } from '../events.ts'
import { DiffView } from './DiffView.tsx'

type Approval = Extract<Item, { kind: 'approval' }>

const VERDICT: Record<Approval['status'], string> = {
  pending: '',
  allowed: 'Approved',
  denied: 'Rejected',
  expired: 'Expired — the server restarted before you answered',
}

/**
 * The review surface. It lives inline in the conversation rather than in a
 * separate diff tab, because the conversation IS the review: you scroll, read
 * what Claude intends, see the diff in place, tap, and keep scrolling.
 */
export function ApprovalCard({ item }: { item: Approval }): React.JSX.Element {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const subject = diffSubjectOf(item.tool, item.input)
  const command = commandOf(item.input)

  async function decide(allow: boolean): Promise<void> {
    setSending(true)
    setError(undefined)
    try {
      await decideApproval(item.approvalId, allow)
      // The status change arrives over SSE, not from this response.
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? 'Already decided, or the server restarted.'
          : err instanceof Error
            ? err.message
            : String(err),
      )
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={`card approval approval-${item.status}`}>
      <div className="approval-head">
        <span className="approval-tool">{item.displayName ?? item.tool}</span>
        {item.status !== 'pending' && <span className="approval-verdict">{VERDICT[item.status]}</span>}
      </div>

      {/* The SDK phrases this for us. Don't reconstruct it from tool + input. */}
      <p className="approval-title">{item.title ?? `Claude wants to run ${item.tool}`}</p>
      {item.description && <p className="approval-desc">{item.description}</p>}

      {subject ? (
        <DiffView subject={subject} />
      ) : command ? (
        <pre className="command">{command}</pre>
      ) : (
        <pre className="command">{JSON.stringify(item.input, null, 2)}</pre>
      )}

      {error && <p className="approval-error">{error}</p>}

      {item.status === 'pending' && (
        <div className="approval-actions">
          <button className="btn btn-deny" disabled={sending} onClick={() => void decide(false)}>
            Reject
          </button>
          <button className="btn btn-allow" disabled={sending} onClick={() => void decide(true)}>
            Approve
          </button>
        </div>
      )}
    </div>
  )
}

function commandOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const command = (input as Record<string, unknown>).command
  return typeof command === 'string' ? command : undefined
}
