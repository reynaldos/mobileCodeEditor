import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { terminalSocketUrl } from '../api.ts'

/** xterm palette wired to the app's theme tokens (xterm needs hex, not CSS vars). */
const THEME = {
  background: '#0b0d10',
  foreground: '#e6e9ee',
  cursor: '#6ea8fe',
  cursorAccent: '#0b0d10',
  selectionBackground: '#26303b',
  black: '#14181d',
  red: '#f85149',
  green: '#2ea043',
  yellow: '#d29922',
  blue: '#6ea8fe',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#e6e9ee',
  brightBlack: '#8b95a3',
  brightRed: '#ff7b72',
  brightGreen: '#3fb950',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#ffffff',
}

/**
 * A live shell (Phase 4): xterm.js on a WebSocket to the project's PTY. Output
 * streams straight in; keystrokes go back framed. A soft-key row supplies the
 * keys a phone keyboard can't — Ctrl (as a sticky modifier), Esc, Tab, and the
 * arrows — since a mobile keyboard can't produce Ctrl-C on its own.
 */
export function Terminal({ projectId }: { projectId: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  // Sticky Ctrl: a ref so the (once-registered) onData handler reads it live, and
  // state so the button reflects it.
  const ctrlRef = useRef(false)
  const [ctrl, setCtrl] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    setStatus('connecting')

    const term = new Xterm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    termRef.current = term

    const ws = new WebSocket(terminalSocketUrl(projectId))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const sendResize = (): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }

    ws.onopen = () => {
      setStatus('open')
      sendResize()
      term.focus()
    }
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer))
    ws.onclose = () => {
      setStatus('closed')
      term.write('\r\n\x1b[90m[session ended — Restart for a new shell]\x1b[0m\r\n')
    }
    ws.onerror = () => setStatus('closed')

    // Focus once the drawer has settled (the open animation + Radix autofocus can
    // otherwise leave focus on the header), so the cursor is live without a click.
    const focusTimer = window.setTimeout(() => term.focus(), 250)

    const dataSub = term.onData((data) => {
      let out = data
      // Sticky Ctrl: fold the next single printable key into its control code
      // (e.g. Ctrl then "c" → \x03), then release the modifier.
      if (ctrlRef.current && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0)
        if (code >= 64 && code <= 95) out = String.fromCharCode(code & 0x1f)
        ctrlRef.current = false
        setCtrl(false)
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: out }))
    })

    // Keep the PTY's grid in step with the rendered size (drawer open animation,
    // orientation change, keyboard show/hide all resize the container).
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* container mid-transition — the next tick refits */
      }
      sendResize()
    })
    observer.observe(container)

    return () => {
      window.clearTimeout(focusTimer)
      observer.disconnect()
      dataSub.dispose()
      ws.close()
      term.dispose()
      termRef.current = null
      wsRef.current = null
    }
  }, [projectId])

  /** Send an explicit sequence from a soft key (no Ctrl folding — these are literal). */
  function sendKey(seq: string): void {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: seq }))
    termRef.current?.focus()
  }

  function toggleCtrl(): void {
    const next = !ctrlRef.current
    ctrlRef.current = next
    setCtrl(next)
    termRef.current?.focus()
  }

  return (
    // `data-vaul-no-drag` is load-bearing: without it the drawer treats a tap on
    // the terminal as the start of a swipe-to-dismiss drag and swallows the
    // pointer, so xterm's hidden textarea never focuses — you see the shell but
    // can't type. Marking the area no-drag lets xterm's own tap-to-focus (and the
    // mobile keyboard) work; the drawer still drags from its header grabber.
    <div data-vaul-no-drag="true" className="relative flex min-h-0 flex-1 flex-col bg-[#0b0d10]">
      {status !== 'open' && (
        <span
          className={`pointer-events-none absolute right-2 top-2 z-10 rounded-md px-2 py-0.5 text-[11px] ${
            status === 'connecting' ? 'bg-panel-2 text-muted' : 'bg-del/20 text-del'
          }`}
        >
          {status === 'connecting' ? 'connecting…' : 'disconnected'}
        </span>
      )}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden p-2"
        onPointerDown={() => termRef.current?.focus()}
      />
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-line bg-panel px-2 py-1.5 [scrollbar-width:none]">
        <SoftKey label="Ctrl" active={ctrl} onClick={toggleCtrl} />
        <SoftKey label="Esc" onClick={() => sendKey('\x1b')} />
        <SoftKey label="Tab" onClick={() => sendKey('\t')} />
        <SoftKey icon={ArrowUp} onClick={() => sendKey('\x1b[A')} />
        <SoftKey icon={ArrowDown} onClick={() => sendKey('\x1b[B')} />
        <SoftKey icon={ArrowLeft} onClick={() => sendKey('\x1b[D')} />
        <SoftKey icon={ArrowRight} onClick={() => sendKey('\x1b[C')} />
        <SoftKey label="|" onClick={() => sendKey('|')} />
        <SoftKey label="~" onClick={() => sendKey('~')} />
        <SoftKey label="/" onClick={() => sendKey('/')} />
        <SoftKey label="-" onClick={() => sendKey('-')} />
      </div>
    </div>
  )
}

function SoftKey({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label?: string
  icon?: React.ComponentType<{ className?: string }>
  active?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      // Don't steal focus from the terminal's hidden textarea on tap.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`flex h-8 min-w-9 shrink-0 items-center justify-center rounded-md border px-2 font-mono text-[13px] ${
        active ? 'border-accent bg-accent/20 text-accent' : 'border-line bg-panel-2 text-fg active:bg-line'
      }`}
    >
      {Icon ? <Icon className="size-4" /> : label}
    </button>
  )
}
