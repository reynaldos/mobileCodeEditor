import { ChevronLeft, Files, GitBranch, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DrawerState } from '../useDrawerState.ts'
import { ActionsMenu } from './ActionsMenu.tsx'
import { FileEditor, tabLabel, useOpenFiles } from './FileEditor.tsx'
import { FileTree } from './FileTree.tsx'
import { PeekDrawer } from './PeekDrawer.tsx'
import { SourceControlView } from './SourceControlView.tsx'

type View = 'tree' | 'file' | 'source-control'

interface Props {
  projectId: string
  projectName: string
  /** Current git branch, shown under the project name — same live `Project.branch` the main header reads, so it tracks branch changes the same way. */
  branch?: string
  /** Which view to land on when this opens — the nav-bar's Explorer and Source control entries (and a project row's Explorer action) each pick one. */
  initialView: View
  /** A file to open straight into the file view when this opens — set by a thread changes card's "View file". Overrides `initialView`. */
  initialFile?: string
  drawer: DrawerState
  /** Strip position while minimized (see `peekSlots`). */
  slot: number
  /** A git op in Source control changed the branch/commit state — refetch the project list so the branch subtitle stays live. */
  onGitChange?: () => void
  /** The user committed from Source control — notify the thread's agent with this summary. */
  onCommitted?: (summary: string) => void
}

/**
 * File browser, read-only viewer, and Source control — one drawer, three
 * internal views (PHASE-3.md design calls 1 and 4). A `PeekDrawer`, like the
 * preview: minimizing keeps the open tabs and the current view in place while
 * you use the thread underneath; closing drops back to the requested view on
 * the next open.
 *
 * Header (design call 2): a back arrow once a file's open — same drawer, same
 * open/close state, just an internal view change. The title is the project
 * name (with its branch), swapping to the active file's name once one's open.
 * Right is the existing `ActionsMenu` kebab, reused as-is, then the ×.
 */
export function ExplorerDrawer({ projectId, projectName, branch, initialView, initialFile, drawer, slot, onGitChange, onCommitted }: Props): React.JSX.Element {
  const [view, setView] = useState<View>(initialView)
  const [refreshKey, setRefreshKey] = useState(0)
  const tabs = useOpenFiles()
  const { open } = drawer

  // The file view (source tabs and markdown-preview tabs alike) takes over the
  // drawer body: a back arrow instead of X, and no Files/Source-control tabs.
  const focused = view === 'file'

  // Reopening lands on whichever view was requested (see PHASE-3.md's
  // acceptance test) — open tabs themselves persist across a close/reopen of
  // the same project. An `initialFile` (from a thread changes card's "View
  // file") wins: open that tab and land straight in the file view.
  useEffect(() => {
    if (!open) return
    if (initialFile) {
      tabs.open(initialFile)
      setView('file')
    } else {
      setView(initialView)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialView, initialFile])

  // Header title mirrors the active tab — `name` for a source tab, `(Preview) name` for a preview tab.
  const activeTabLabel = tabs.active ? tabLabel(tabs.active) : undefined

  function openFile(path: string): void {
    tabs.open(path)
    setView('file')
  }

  function openPreview(path: string): void {
    tabs.openPreview(path)
    setView('file')
  }

  const title = focused ? (activeTabLabel ?? projectName) : projectName

  return (
    <PeekDrawer
      open={open}
      raised={drawer.raised}
      slot={slot}
      onRaise={drawer.raise}
      onPeek={drawer.peek}
      onClose={drawer.close}
      leading={
        focused ? (
          <button
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-line"
            aria-label="Back to files"
            onClick={() => setView('tree')}
          >
            <ChevronLeft className="size-5" />
          </button>
        ) : undefined
      }
      title={
        <>
          {title}
          {/* Branch belongs with the project name — hidden in the focused file/preview view where the title is a filename. */}
          {!focused && branch && <span className="font-normal text-muted"> · {branch}</span>}
        </>
      }
      actions={
        <ActionsMenu
          actions={[{ key: 'refresh', label: 'Refresh', icon: RotateCw, onClick: () => setRefreshKey((k) => k + 1) }]}
        />
      }
      closeLabel="Close explorer"
    >
      {!focused && (
        <div className="flex shrink-0 gap-1 border-b border-line px-2 py-1.5">
          <ViewTab label="Files" icon={Files} active={view === 'tree'} onClick={() => setView('tree')} />
          <ViewTab
            label="Source control"
            icon={GitBranch}
            active={view === 'source-control'}
            onClick={() => setView('source-control')}
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {view === 'tree' && (
          <FileTree key={`tree-${refreshKey}`} projectId={projectId} onOpenFile={openFile} onPreview={openPreview} />
        )}
        {view === 'source-control' && (
          <SourceControlView
            key={`sc-${refreshKey}`}
            projectId={projectId}
            onOpenFile={openFile}
            onGitChange={onGitChange}
            onCommitted={onCommitted}
          />
        )}
        <FileEditor projectId={projectId} tabs={tabs} hidden={view !== 'file'} />
      </div>
    </PeekDrawer>
  )
}

function ViewTab({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px] ${
        active ? 'bg-panel-2 text-fg' : 'text-muted'
      }`}
      onClick={onClick}
    >
      <Icon className="size-4" />
      {label}
    </button>
  )
}
