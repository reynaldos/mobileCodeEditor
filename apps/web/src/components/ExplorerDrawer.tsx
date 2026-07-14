import { ChevronLeft, Files, GitBranch, RotateCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ActionsMenu } from './ActionsMenu.tsx'
import { FileEditor, useOpenFiles } from './FileEditor.tsx'
import { FileTree } from './FileTree.tsx'
import { SourceControlView } from './SourceControlView.tsx'
import { Drawer, DrawerContent } from './ui/drawer.tsx'

type View = 'tree' | 'file' | 'source-control'

interface Props {
  projectId: string
  projectName: string
  /** Which view to land on when this opens — the nav-bar's Explorer and Source control entries (and a project row's Explorer action) each pick one. */
  initialView: View
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * File browser, read-only viewer, and Source control — one drawer, three
 * internal views (PHASE-3.md design calls 1 and 4). A modal `Drawer`, not
 * the peekable one `PreviewDrawer` uses: nothing here keeps running in the
 * background, so there's no reason to keep it reachable while peeked.
 *
 * Header (design call 2): X at the top level (tree or Source control), a
 * back arrow once a file's open — same drawer, same open/close state, just
 * an internal view change. Center title is the project name, swapping to
 * the active file's name once one's open. Right is the existing
 * `ActionsMenu` kebab, reused as-is.
 */
export function ExplorerDrawer({ projectId, projectName, initialView, open, onOpenChange }: Props): React.JSX.Element {
  const [view, setView] = useState<View>(initialView)
  const [refreshKey, setRefreshKey] = useState(0)
  const tabs = useOpenFiles()

  // Reopening lands on whichever view was requested (see PHASE-3.md's
  // acceptance test) — open tabs themselves persist across a close/reopen of
  // the same project.
  useEffect(() => {
    if (open) setView(initialView)
  }, [open, initialView])

  const activeFileName = tabs.active?.split('/').pop()

  function openFile(path: string): void {
    tabs.open(path)
    setView('file')
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="h-[92vh] max-h-[92vh]">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 pb-3">
          <button
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-panel-2"
            aria-label={view === 'file' ? 'Back to files' : 'Close'}
            onClick={view === 'file' ? () => setView('tree') : () => onOpenChange(false)}
          >
            {view === 'file' ? <ChevronLeft className="size-5" /> : <X className="size-5" />}
          </button>
          <span className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold text-fg">
            {view === 'file' ? (activeFileName ?? projectName) : projectName}
          </span>
          <ActionsMenu
            actions={[{ key: 'refresh', label: 'Refresh', icon: RotateCw, onClick: () => setRefreshKey((k) => k + 1) }]}
          />
        </div>

        {view !== 'file' && (
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
          {view === 'tree' && <FileTree key={`tree-${refreshKey}`} projectId={projectId} onOpenFile={openFile} />}
          {view === 'source-control' && <SourceControlView key={`sc-${refreshKey}`} projectId={projectId} />}
          <FileEditor projectId={projectId} tabs={tabs} hidden={view !== 'file'} />
        </div>
      </DrawerContent>
    </Drawer>
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
