import { useState } from 'react'
import { ApiError, decideApproval } from '../api.ts'
import { diffSubjectOf } from '../diff.ts'
import type { Item } from '../events.ts'
import { describeTool, relativePath } from '../paths.ts'
import { DiffView } from './DiffView.tsx'

type Approval = Extract<Item, { kind: 'approval' }>

const VERDICT: Record<Approval['status'], string> = {
  pending: '',
  allowed: 'Approved',
  denied: 'Rejected',
  expired: 'Expired — the server restarted before you answered',
}

interface Props {
  item: Approval
  projectPath?: string
}

/**
 * The review surface. It lives inline in the conversation rather than in a
 * separate diff tab, because the conversation IS the review: you scroll, read
 * what Claude intends, see the diff in place, tap, and keep scrolling.
 *
 * While pending it is `position: sticky` at the bottom of the list. The agent is
 * blocked on this card — if it can scroll out of reach, the UI can hang the
 * agent, and the SDK gives permission prompts no deadline.
 */
export function ApprovalCard({ item, projectPath }: Props): React.JSX.Element {
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

      {/* The SDK phrases this when it can, but often doesn't. Fall back to
          something that names the file rather than just the tool. */}
      <p className="approval-title">{item.title ?? describeTool(item.tool, item.input, projectPath)}</p>
      {item.description && <p className="approval-desc">{item.description}</p>}

      {subject ? (
        <DiffView
          subject={{
            ...subject,
            filePath: subject.filePath ? relativePath(subject.filePath, projectPath) : undefined,
          }}
        />
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
