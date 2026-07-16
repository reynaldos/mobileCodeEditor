import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { spawn } from 'node-pty'
import { WebSocket, WebSocketServer } from 'ws'
import { parseTerminalMessage, resolveShell } from '../terminal.ts'
import type { ProjectStore } from '../projects.ts'

/** `/api/projects/:projectId/terminal` — the one path this owns. */
const TERMINAL_PATH = /^\/api\/projects\/([^/]+)\/terminal\/?$/

/**
 * Terminal (Phase 4): a real shell in the project directory, over a WebSocket.
 * Bytes only — the PTY's output streams straight to xterm, and xterm's input
 * comes back framed (see `terminal.ts`). node-pty is a native module; the deploy
 * image already builds native addons for better-sqlite3, so it needs nothing new.
 *
 * The preview reverse-proxy (`@fastify/http-proxy`, websocket) installs ONE
 * shared `upgrade` listener that routes via Fastify and 404s anything it doesn't
 * recognize. Node fires all `upgrade` listeners synchronously, so a second raw
 * listener of ours loses the race — the proxy's 404 clobbers our async handshake
 * (verified). So instead of adding a listener, we take over the server's single
 * upgrade handler in `onReady` (after every plugin has installed its own): claim
 * the terminal path, delegate everything else to whatever was already there (the
 * proxy). No approval gate — this is the user's shell, not the agent's (the
 * agent's Bash still goes through `canUseTool`); Tailscale is the perimeter.
 */
export function registerTerminal(app: FastifyInstance, projects: ProjectStore): void {
  const wss = new WebSocketServer({ noServer: true })

  /** Claim + serve a terminal upgrade. Returns false if the path isn't ours. */
  function claim(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const match = TERMINAL_PATH.exec(path)
    if (!match) return false

    const projectId = decodeURIComponent(match[1] ?? '')
    const cwd = projects.exists(projectId) ? projects.pathOf(projectId) : undefined
    if (!cwd) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return true
    }
    wss.handleUpgrade(req, socket, head, (ws) => startSession(ws, cwd))
    return true
  }

  type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

  app.addHook('onReady', async () => {
    // Everything registered before us (notably the preview proxy) has installed
    // its upgrade listener by now. Capture them, then become the sole router.
    const prior = app.server.listeners('upgrade').slice() as UpgradeListener[]
    app.server.removeAllListeners('upgrade')
    app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (claim(req, socket, head)) return
      if (prior.length === 0) {
        socket.destroy() // nobody to handle it — don't leave the socket hanging
        return
      }
      for (const listener of prior) listener.call(app.server, req, socket, head)
    })
  })

  // Kill every live shell when the server goes down, so no PTY is orphaned.
  app.addHook('onClose', async () => {
    for (const ws of wss.clients) ws.terminate()
    wss.close()
  })
}

/** Wire one WebSocket to a fresh PTY: output → socket, framed input → PTY, both cleaned up together. */
function startSession(ws: WebSocket, cwd: string): void {
  const pty = spawn(resolveShell(), [], {
    name: 'xterm-256color',
    cwd,
    cols: 80,
    rows: 24,
    env: { ...process.env, TERM: 'xterm-256color' },
  })

  const onData = pty.onData((chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk)
  })
  const onExit = pty.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) ws.close()
  })

  ws.on('message', (raw) => {
    const msg = parseTerminalMessage(raw.toString())
    if (!msg) return
    if (msg.type === 'input') pty.write(msg.data)
    else pty.resize(msg.cols, msg.rows)
  })

  const cleanup = (): void => {
    onData.dispose()
    onExit.dispose()
    try {
      pty.kill()
    } catch {
      /* already gone */
    }
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
}
