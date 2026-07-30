import type { EnvEntry } from '@mce/protocol'
import { ChevronDown, ClipboardPaste, Eye, EyeOff, Loader, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fetchEnv, initEnv, saveEnv } from '../api.ts'
import { looksLikeEnvBlock, mergeEnvEntries, parseEnvBlock } from '../env.ts'
import { PeekableDrawer } from './ui/peekable-drawer.tsx'

/** Peeked-strip height — shared with every other peekable drawer. */
export const ENV_PEEK = '72px'

interface Props {
  projectId: string | null
  open: boolean
  /** Full-height vs peeked-strip. Meaningless while `open` is false. */
  raised: boolean
  onRaisedChange: (raised: boolean) => void
  onOpenChange: (open: boolean) => void
  /** Other peeked drawers' combined peek height below this one in the stack, so peek strips don't overlap. */
  bottomOffset?: string
}

/**
 * Edits a project's `.env` directly. The UI is a view over the file — Save writes
 * the whole file (no abstraction, no separate store). Values are masked by default
 * since they're secrets; a toggle reveals them. Minimizing (instead of closing)
 * keeps unsaved edits in the form alive.
 */
export function EnvDrawer({ projectId, open, raised, onRaisedChange, onOpenChange, bottomOffset }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<EnvEntry[]>([])
  const [hasExample, setHasExample] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState<string | undefined>()
  // The "Paste .env" panel: a textarea you drop a whole block into. Reliable on
  // mobile where clipboard-read permission and paste interception are flaky.
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')

  useEffect(() => {
    if (!open || !projectId) return
    setLoading(true)
    setError(undefined)
    setSaved(false)
    setPasteOpen(false)
    setPasteText('')
    fetchEnv(projectId)
      .then((r) => {
        setEntries(r.entries)
        setHasExample(r.hasExample)
      })
      .catch(() => setError('Could not read .env.'))
      .finally(() => setLoading(false))
  }, [open, projectId])

  function setRow(i: number, patch: Partial<EnvEntry>): void {
    setEntries((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)))
    setSaved(false)
  }
  const addRow = (): void => {
    setEntries((prev) => [...prev, { key: '', value: '' }])
    setSaved(false)
  }
  const removeRow = (i: number): void => {
    setEntries((prev) => prev.filter((_, j) => j !== i))
    setSaved(false)
  }

  /** Parse a pasted `.env` block and merge it into the rows (upsert by key). */
  function applyPaste(text: string): boolean {
    const parsed = parseEnvBlock(text)
    if (parsed.length === 0) return false
    setEntries((prev) => mergeEnvEntries(prev, parsed))
    setSaved(false)
    return true
  }

  function commitPaste(): void {
    applyPaste(pasteText)
    setPasteText('')
    setPasteOpen(false)
  }

  async function scaffold(): Promise<void> {
    if (!projectId) return
    const r = await initEnv(projectId).catch(() => undefined)
    if (r) setEntries(r.entries)
  }

  async function save(): Promise<void> {
    if (!projectId) return
    setSaving(true)
    setError(undefined)
    try {
      await saveEnv(
        projectId,
        entries.filter((e) => e.key.trim()),
      )
      setSaved(true)
    } catch {
      setError('Could not save .env.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <PeekableDrawer
      open={open}
      raised={raised}
      onRaisedChange={onRaisedChange}
      onOpenChange={onOpenChange}
      peekHeight={ENV_PEEK}
      bottomOffset={bottomOffset}
      title="Environment · .env"
    >
      <div className="flex flex-col gap-1 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <button
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2"
              aria-label="Minimize"
              title="Minimize"
              onClick={() => onRaisedChange(false)}
            >
              <ChevronDown className="size-4" />
            </button>
            <span className="truncate text-[17px] font-semibold text-fg">Environment · .env</span>
          </div>
          <button
            className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted hover:text-fg"
            onClick={() => setReveal((r) => !r)}
          >
            {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            {reveal ? 'Hide' : 'Show'} values
          </button>
        </div>
        <p className="text-[13px] text-muted">Written straight to the project&rsquo;s .env file on save.</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
              <Loader className="size-4 animate-spin" /> loading…
            </div>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {entries.length === 0 && (
                  <div className="flex flex-col items-center gap-3 py-8 text-center">
                    <p className="text-[13px] text-muted">No variables yet.</p>
                    {hasExample && (
                      <button
                        className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] text-fg"
                        onClick={() => void scaffold()}
                      >
                        Load keys from .env.example
                      </button>
                    )}
                  </div>
                )}

                <ul className="flex flex-col gap-2">
                  {entries.map((e, i) => (
                    <li key={i} className="flex items-center gap-1.5">
                      <input
                        className="min-h-10 w-2/5 shrink-0 rounded-lg border border-line bg-panel-2 px-2.5 font-mono text-[13px] text-fg outline-none focus:border-accent"
                        placeholder="KEY"
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                        value={e.key}
                        onChange={(ev) => setRow(i, { key: ev.target.value })}
                        onPaste={(ev) => {
                          // Paste a whole KEY=value block into a key field and it
                          // expands into rows; an ordinary key paste falls through.
                          const text = ev.clipboardData.getData('text')
                          if (looksLikeEnvBlock(text) && applyPaste(text)) ev.preventDefault()
                        }}
                      />
                      <input
                        className="min-h-10 w-0 flex-1 rounded-lg border border-line bg-panel-2 px-2.5 font-mono text-[13px] text-fg outline-none focus:border-accent"
                        placeholder="value"
                        type={reveal ? 'text' : 'password'}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        value={e.value}
                        onChange={(ev) => setRow(i, { value: ev.target.value })}
                      />
                      <button
                        className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-line"
                        aria-label="Remove"
                        onClick={() => removeRow(i)}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    className="flex items-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-2 text-[13px] text-muted hover:text-fg"
                    onClick={addRow}
                  >
                    <Plus className="size-4" /> Add variable
                  </button>
                  <button
                    className={`flex items-center gap-1.5 rounded-lg border border-dashed px-3 py-2 text-[13px] ${
                      pasteOpen ? 'border-accent text-accent' : 'border-line text-muted hover:text-fg'
                    }`}
                    onClick={() => setPasteOpen((o) => !o)}
                  >
                    <ClipboardPaste className="size-4" /> Paste .env
                  </button>
                </div>

                {pasteOpen && (
                  <div className="mt-2 rounded-lg border border-line bg-panel-2 p-2">
                    <textarea
                      className="min-h-24 w-full resize-y rounded-md border border-line bg-panel px-2.5 py-2 font-mono text-[13px] text-fg outline-none focus:border-accent"
                      placeholder={'Paste a block, e.g.\nAPI_KEY=sk-…\nDATABASE_URL=postgres://…'}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={pasteText}
                      onChange={(ev) => setPasteText(ev.target.value)}
                      autoFocus
                    />
                    <div className="mt-2 flex items-center justify-end gap-2">
                      <button
                        className="rounded-lg px-3 py-1.5 text-[13px] text-muted hover:text-fg"
                        onClick={() => {
                          setPasteText('')
                          setPasteOpen(false)
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        className="rounded-lg border border-accent bg-accent px-3 py-1.5 text-[13px] font-semibold text-[#06101f] disabled:opacity-50"
                        disabled={parseEnvBlock(pasteText).length === 0}
                        onClick={commitPaste}
                      >
                        Add {parseEnvBlock(pasteText).length || ''} variable{parseEnvBlock(pasteText).length === 1 ? '' : 's'}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {error && <p className="shrink-0 text-[13px] text-del">{error}</p>}

              <button
                className="min-h-11 shrink-0 rounded-xl border border-accent bg-accent font-semibold text-[#06101f] disabled:opacity-50"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : saved ? 'Saved' : 'Save .env'}
              </button>
            </>
          )}
        </div>
    </PeekableDrawer>
  )
}
