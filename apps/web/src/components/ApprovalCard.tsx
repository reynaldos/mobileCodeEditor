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

/** `approval-pending` is not decoration: it makes the card sticky. See styles.css. */
const STATUS: Record<Approval['status'], string> = {
  pending: 'approval-pending border-warn bg-panel',
  allowed: 'border-line bg-panel opacity-70',
  denied: 'border-line bg-panel opacity-60',
  expired: 'border-line bg-panel opacity-60',
}

interface Props {
  item: Approval
  projectId?: string
}

/**
 * The review surface. It lives inline in the conversation rather than in a
 * separate diff tab, because the conversation IS the review: you scroll, read
 * what Claude intends, see the diff in place, tap, and keep scrolling.
 */
export function ApprovalCard({ item, projectId }: Props): React.JSX.Element {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const subject = diffSubjectOf(item.tool, item.input)
  const command = commandOf(item.input)

  async function decide(allow: boolean, always = false): Promise<void> {
    setSending(true)
    setError(undefined)
    try {
      await decideApproval(item.approvalId, allow, { always })
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
    <div className={`overflow-hidden rounded-xl border ${STATUS[item.status]}`}>
      <div className="flex items-baseline justify-between px-3 pt-2.5">
        <span className="text-[11px] uppercase tracking-[0.08em] text-muted">
          {item.displayName ?? item.tool}
        </span>
        {item.status !== 'pending' && (
          <span className="text-[11px] text-muted">{VERDICT[item.status]}</span>
        )}
      </div>

      {/* The SDK phrases this when it can, but often doesn't. Fall back to
          something that names the file rather than just the tool. */}
      <p className="mx-3 mt-1.5 font-medium">
        {item.title ?? describeTool(item.tool, item.input, projectId)}
      </p>
      {item.description && <p className="mx-3 mt-1 text-[13px] text-muted">{item.description}</p>}

      {subject ? (
        <DiffView
          subject={{
            ...subject,
            filePath: subject.filePath ? relativePath(subject.filePath, projectId) : undefined,
          }}
        />
      ) : (
        <pre className="scroll-cap m-0 mt-2.5 overflow-x-auto whitespace-pre border-t border-line bg-[#0d1117] px-3 py-2.5 font-mono text-xs">
          {command ?? JSON.stringify(item.input, null, 2)}
        </pre>
      )}

      {error && <p className="mx-3 mt-1 text-[13px] text-del">{error}</p>}

      {item.status === 'pending' && (
        <div className="flex flex-col gap-2 p-3">
          <div className="flex gap-2">
            {/* 44px is the smallest thing a thumb reliably hits. */}
            <button
              className="min-h-11 flex-1 rounded-[10px] border border-[#4a2326] bg-transparent font-semibold text-del disabled:opacity-50"
              disabled={sending}
              onClick={() => void decide(false)}
            >
              Reject
            </button>
            <button
              className="min-h-11 flex-1 rounded-[10px] border border-add bg-add font-semibold text-[#04140a] disabled:opacity-50"
              disabled={sending}
              onClick={() => void decide(true)}
            >
              Approve
            </button>
          </div>
          {/* Approve AND stop asking for this — the derived rule is named so it's
              never a surprise (all git vs. just `git status`). */}
          <button
            className="min-h-10 rounded-[10px] border border-line bg-panel-2 text-[13px] font-medium text-muted disabled:opacity-50"
            disabled={sending}
            onClick={() => void decide(true, true)}
          >
            {alwaysLabel(item.tool, item.input)}
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

// Mirrors ruleFor() in session.ts so the button names exactly what it will allow.
const SUBCOMMANDED = new Set([
  'git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'docker', 'cargo', 'go', 'kubectl', 'fly', 'pip', 'make', 'brew',
])

function alwaysLabel(tool: string, input: unknown): string {
  if (tool === 'Bash') {
    const command = commandOf(input)
    if (command) {
      const tokens = command.trim().split(/\s+/)
      const first = tokens[0] ?? ''
      const key =
        SUBCOMMANDED.has(first) && tokens[1] && !tokens[1].startsWith('-') ? `${first} ${tokens[1]}` : first
      return `Always allow "${key}"`
    }
  }
  return `Always allow ${tool}`
}
