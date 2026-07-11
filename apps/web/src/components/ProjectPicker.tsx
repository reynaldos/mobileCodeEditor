import type { Project } from '@mce/protocol'
import { useState } from 'react'
import { ApiError, createProject } from '../api.ts'

interface Props {
  projects: Project[]
  activeId: string | null
  /** Names that failed to clone/init, keyed by name → error. From the event stream. */
  failed: Record<string, string>
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * A full-screen overlay, not a router — Phase 2's IA is still "one screen plus a
 * picker". Tap a project to switch to it; add one by pasting a GitHub URL or
 * naming a fresh repo.
 */
export function ProjectPicker({ projects, activeId, failed, onSelect, onClose }: Props): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-bg/95 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-line px-4 pb-3 pt-[calc(12px+env(safe-area-inset-top,0px))]">
        <span className="font-semibold">Projects</span>
        <button className="h-8 rounded-lg border border-line bg-panel-2 px-3 text-[13px] text-muted" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        <ul className="flex flex-col gap-2">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                className={`w-full rounded-xl border p-3 text-left ${
                  p.id === activeId ? 'border-accent bg-panel' : 'border-line bg-panel-2'
                }`}
                onClick={() => onSelect(p.id)}
              >
                <div className="flex items-center justify-between">
                  <span className="truncate font-medium">{p.name}</span>
                  {p.id === activeId && <span className="text-[11px] text-accent">active</span>}
                </div>
                <div className="mt-0.5 truncate text-[12px] text-muted">
                  {p.repoUrl ?? 'local'} {p.branch ? `· ${p.branch}` : ''}
                </div>
                {failed[p.name] && <div className="mt-1 text-[12px] text-del">{failed[p.name]}</div>}
              </button>
            </li>
          ))}
          {projects.length === 0 && (
            <li className="py-6 text-center text-muted">No projects yet. Add one below.</li>
          )}
        </ul>

        <NewProjectForm failed={failed} />
      </div>
    </div>
  )
}

/**
 * Paste a GitHub URL (clone) or a name (fresh repo). Create returns 202; the
 * project appears in the list above when its `project_created` event lands, which
 * is why the parent refetches on that signal. Errors show as `failed[name]`.
 */
function NewProjectForm({ failed }: { failed: Record<string, string> }): React.JSX.Element {
  const [value, setValue] = useState('')
  const [pending, setPending] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  // A clone that failed clears the pending spinner.
  const pendingError = pending ? failed[pending] : undefined

  async function submit(): Promise<void> {
    const v = value.trim()
    if (!v) return
    setError(undefined)

    const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/.test(v)
    try {
      const { projectId } = await createProject(isUrl ? { repoUrl: v } : { name: v })
      setPending(projectId) // spinner until it shows up in the list, or fails
      setValue('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <div className="mt-6 border-t border-line pt-4">
      <p className="mb-2 text-[13px] text-muted">Add a project — a GitHub URL to clone, or a name for a fresh repo.</p>
      <div className="flex gap-2">
        <input
          className="min-h-11 flex-1 rounded-xl border border-line bg-panel-2 px-3 text-[16px] text-fg outline-none focus:border-accent"
          value={value}
          placeholder="github.com/you/repo  ·  or  my-idea"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        <button
          className="min-h-11 shrink-0 rounded-xl border border-accent bg-accent px-4 font-semibold text-[#06101f] disabled:opacity-50"
          disabled={!value.trim()}
          onClick={() => void submit()}
        >
          Add
        </button>
      </div>

      {pending && !pendingError && (
        <p className="mt-2 text-[13px] text-accent">Creating {pending}… it&rsquo;ll appear above when ready.</p>
      )}
      {pendingError && <p className="mt-2 text-[13px] text-del">{pending}: {pendingError}</p>}
      {error && <p className="mt-2 text-[13px] text-del">{error}</p>}
    </div>
  )
}
