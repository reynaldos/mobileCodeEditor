import type {
  AnswerQuestionRequest,
  ApprovalRequest,
  CreateProjectRequest,
  CreateProjectResponse,
  EnvEntry,
  EnvFileResponse,
  FsFileResponse,
  FsSearchResponse,
  FsTreeResponse,
  GithubRepo,
  GithubReposResponse,
  GitStatusResponse,
  ImageRef,
  NameCheckResponse,
  NewThreadResponse,
  FileDiffResponse,
  PresenceRequest,
  Project,
  ProjectsResponse,
  PromptRequest,
  PromptResponse,
  RemoveProjectRequest,
  RenameThreadRequest,
  StartPreviewRequest,
  StorageResponse,
  Thread,
  ThreadsResponse,
  UploadImagesResponse,
} from '@mce/protocol'

/**
 * Every server call goes through this file.
 *
 * The day URLs gain a workspace prefix — when one container becomes many — that
 * is a change here and nowhere else. See DECISIONS #14.
 *
 * Empty in production, because the workspace server serves this app from the
 * same origin. Set VITE_API_BASE=http://localhost:3000 for `vite dev`.
 */
const BASE: string = import.meta.env.VITE_API_BASE ?? ''

/** `clientId` ties this connection to its presence reports — see reportVisibility. */
export const eventStreamUrl = (clientId: string): string =>
  `${BASE}/api/events?clientId=${encodeURIComponent(clientId)}`

/**
 * Tells the server whether this tab can currently be seen, so the Notifier
 * never buzzes a screen someone is already looking at. Fire-and-forget by
 * design — a lost presence update just means a push that should've been
 * suppressed goes through, never the other way around (see notifier.ts).
 *
 * `sendBeacon` on the way to hidden: that call happens right as the page may
 * be frozen (iOS backgrounding), and a beacon is queued by the browser itself
 * rather than riding a fetch that can get cancelled mid-flight.
 */
export function reportVisibility(clientId: string, visible: boolean): void {
  const body = JSON.stringify({ clientId, visible } satisfies PresenceRequest)
  const url = `${BASE}/api/presence`

  if (!visible && navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }))) return

  void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(
    () => {
      // Best-effort. The next visibilitychange or SSE reconnect tries again.
    },
  )
}

/** SSE of a project's live setup output (clone + install). */
export const buildStreamUrl = (projectId: string): string =>
  `${BASE}/api/projects/${encodeURIComponent(projectId)}/build`

/** SSE of the active preview's phase + dev-server output (Phase 5). */
export const previewStreamUrl = (projectId: string): string =>
  `${BASE}/api/projects/${encodeURIComponent(projectId)}/preview/stream`

/** Same-origin, reverse-proxied URL for the preview iframe / "open in new tab". */
export const previewUrl = (projectId: string): string => `${BASE}/preview/${encodeURIComponent(projectId)}/`

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function post<T>(path: string, body: unknown): Promise<T | undefined> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}) as { error?: string })
    throw new ApiError(response.status, detail.error ?? response.statusText)
  }
  if (response.status === 204) return undefined
  return (await response.json()) as T
}

/** 202. The answer arrives over SSE, not in this response. */
export async function sendPrompt(
  text: string,
  projectId: string,
  threadId: string,
  imageIds: string[] = [],
): Promise<PromptResponse> {
  return (await post<PromptResponse>('/api/prompt', {
    text,
    projectId,
    threadId,
    ...(imageIds.length ? { imageIds } : {}),
  } satisfies PromptRequest))!
}

/**
 * Upload one or more images, staged for the next prompt. A raw `fetch`, not
 * `post()` — that helper hardcodes JSON content-type, but a multipart body
 * needs the browser to set its own boundary.
 */
export async function uploadImages(files: File[]): Promise<ImageRef[]> {
  const form = new FormData()
  for (const file of files) form.append('images', file, file.name)

  const response = await fetch(`${BASE}/api/uploads/images`, { method: 'POST', body: form })
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}) as { error?: string })
    throw new ApiError(response.status, detail.error ?? response.statusText)
  }
  return ((await response.json()) as UploadImagesResponse).images
}

/** Where an uploaded image's bytes live — used for both the compose-box preview and message rendering. */
export const imageUrl = (id: string): string => `${BASE}/api/uploads/images/${encodeURIComponent(id)}`

/** The project's threads, newest activity first. */
export async function fetchThreads(projectId: string): Promise<Thread[]> {
  const response = await fetch(`${BASE}/api/projects/${encodeURIComponent(projectId)}/threads`)
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return ((await response.json()) as ThreadsResponse).threads
}

/** Mint a fresh thread; returns its id. */
export async function createThread(projectId: string): Promise<string> {
  const res = await post<NewThreadResponse>(`/api/projects/${encodeURIComponent(projectId)}/threads`, {})
  return res!.threadId
}

const threadUrl = (projectId: string, threadId: string): string =>
  `${BASE}/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`

async function expectOk(response: Response): Promise<void> {
  if (response.ok) return
  const detail = await response.json().catch(() => ({}) as { error?: string })
  throw new ApiError(response.status, detail.error ?? response.statusText)
}

/** Give a thread a custom title. 204 on success. */
export async function renameThread(projectId: string, threadId: string, title: string): Promise<void> {
  await expectOk(
    await fetch(threadUrl(projectId, threadId), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title } satisfies RenameThreadRequest),
    }),
  )
}

/** Hide a thread from the list (the log keeps its events). 204 on success. */
export async function deleteThread(projectId: string, threadId: string): Promise<void> {
  await expectOk(await fetch(threadUrl(projectId, threadId), { method: 'DELETE' }))
}

/** Abort an in-progress build; the server SIGTERMs the child and cleans up. 202/409. */
export async function cancelBuild(projectId: string): Promise<void> {
  await expectOk(await fetch(`${BASE}/api/projects/${encodeURIComponent(projectId)}/build/cancel`, { method: 'POST' }))
}

/** A different project's preview is active — the caller offers the confirm-and-evict dialog, then retries with `force: true`. */
export class PreviewConflictError extends ApiError {
  constructor(
    message: string,
    readonly activeProjectId: string,
  ) {
    super(409, message)
  }
}

/**
 * Start the (system-wide, single-slot) preview dev server for a project. Throws
 * `PreviewConflictError` if a different project's preview is active and `force`
 * wasn't set, or a plain `ApiError` (422) if the project has no detected dev
 * command. 202 — the actual phase arrives over `previewStreamUrl`.
 */
export async function startPreview(projectId: string, force = false): Promise<void> {
  const response = await fetch(`${BASE}/api/projects/${encodeURIComponent(projectId)}/preview/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force } satisfies StartPreviewRequest),
  })
  if (response.ok) return

  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; activeProjectId?: string }
    throw new PreviewConflictError(body.error ?? 'a different preview is active', body.activeProjectId ?? '')
  }
  const detail = await response.json().catch(() => ({}) as { error?: string })
  throw new ApiError(response.status, detail.error ?? response.statusText)
}

/** Stop the active preview, if `projectId` is the one holding it. Idempotent otherwise. 202. */
export async function stopPreview(projectId: string): Promise<void> {
  await expectOk(await fetch(`${BASE}/api/projects/${encodeURIComponent(projectId)}/preview/stop`, { method: 'POST' }))
}

/** Before/after text for one changed file, for the post-turn diff accordion. */
export async function fetchFileDiff(projectId: string, base: string, path: string): Promise<FileDiffResponse> {
  const url = `${BASE}/api/projects/${encodeURIComponent(projectId)}/changes?base=${encodeURIComponent(base)}&path=${encodeURIComponent(path)}`
  const response = await fetch(url)
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return (await response.json()) as FileDiffResponse
}

/** The projects the picker shows. Authoritative — the server reads disk. */
export async function fetchProjects(): Promise<Project[]> {
  const response = await fetch(`${BASE}/api/projects`)
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return ((await response.json()) as ProjectsResponse).projects
}

/** Disk usage of the projects volume — bytes. Powers the picker's storage bar. */
export async function fetchStorage(): Promise<StorageResponse> {
  const response = await fetch(`${BASE}/api/storage`)
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return (await response.json()) as StorageResponse
}

/**
 * Clone (repoUrl) or create (name). Returns 202 with the projectId; watch the
 * event stream for `project_created` / `project_create_failed`, since a clone
 * is slow.
 */
export async function createProject(body: CreateProjectRequest): Promise<CreateProjectResponse> {
  return (await post<CreateProjectResponse>('/api/projects', body))!
}

/**
 * Re-run dependency install for an existing project (the fix for a preview that
 * fails with a `.../.bin/<tool> ENOENT`). 202; watch the build stream for
 * progress, same as create.
 */
export async function installDependencies(projectId: string): Promise<void> {
  const response = await fetch(`${BASE}/api/projects/${encodeURIComponent(projectId)}/install`, { method: 'POST' })
  if (!response.ok) throw new ApiError(response.status, response.statusText)
}

/** A live session/build/preview is still using the project — the caller offers a confirm dialog listing `blockers`, then retries with `force: true`. */
export class RemoveProjectConflictError extends ApiError {
  constructor(
    message: string,
    readonly blockers: string[],
  ) {
    super(409, message)
  }
}

/**
 * Remove ("offload") a project's local directory only — its git remote, if
 * any, is never touched; re-cloning by `repoUrl` brings it back. Throws
 * `RemoveProjectConflictError` if a live session/build/preview is still using
 * it and `force` wasn't set. 204 on success.
 */
export async function removeProject(projectId: string, force = false): Promise<void> {
  const response = await fetch(`${BASE}/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force } satisfies RemoveProjectRequest),
  })
  if (response.ok) return

  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; blockers?: string[] }
    throw new RemoveProjectConflictError(body.error ?? "can't remove — something is still using this project", body.blockers ?? [])
  }
  const detail = await response.json().catch(() => ({}) as { error?: string })
  throw new ApiError(response.status, detail.error ?? response.statusText)
}

/** Clone suggestions. Empty when GitHub isn't configured — the field still takes a URL. */
export async function fetchGithubRepos(q: string): Promise<GithubRepo[]> {
  const response = await fetch(`${BASE}/api/github/repos?q=${encodeURIComponent(q)}`)
  if (response.status === 503) return []
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return ((await response.json()) as GithubReposResponse).repos
}

/** null when GitHub isn't configured — skip the availability UI in that case. */
export async function checkProjectName(name: string): Promise<NameCheckResponse | null> {
  const response = await fetch(`${BASE}/api/github/check-name?name=${encodeURIComponent(name)}`)
  if (response.status === 503) return null
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return (await response.json()) as NameCheckResponse
}

/**
 * Resolves the promise `canUseTool` is parked on. 409 if already decided or
 * expired. `always` persists an allow-rule so this tool/command stops prompting.
 */
export async function decideApproval(
  approvalId: string,
  allow: boolean,
  opts: { reason?: string; always?: boolean } = {},
): Promise<void> {
  await post<void>(`/api/approvals/${encodeURIComponent(approvalId)}`, {
    allow,
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.always ? { always: true } : {}),
  } satisfies ApprovalRequest)
}

/** Answer a parked AskUserQuestion. `answers` is keyed by question text. 409 if not pending. */
export async function answerQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
  await post<void>(`/api/questions/${encodeURIComponent(requestId)}`, { answers } satisfies AnswerQuestionRequest)
}

const envUrl = (projectId: string): string => `${BASE}/api/projects/${encodeURIComponent(projectId)}/env`

/** The project's .env as key/value entries, plus whether a .env.example exists. */
export async function fetchEnv(projectId: string): Promise<EnvFileResponse> {
  const response = await fetch(envUrl(projectId))
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return (await response.json()) as EnvFileResponse
}

/** A scaffold proposal from .env.example (keys, blank values). Not written until saved. */
export async function initEnv(projectId: string): Promise<EnvFileResponse> {
  return (await post<EnvFileResponse>(`/api/projects/${encodeURIComponent(projectId)}/env/init`, {}))!
}

/** Write the project's .env from these entries. 204 on success. */
export async function saveEnv(projectId: string, entries: EnvEntry[]): Promise<void> {
  await expectOk(
    await fetch(envUrl(projectId), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries }),
    }),
  )
}

/** The server's public VAPID key, fetched at enable time so key rotation is server-only. */
export async function getPushKey(): Promise<{ key: string }> {
  const response = await fetch(`${BASE}/api/push/key`)
  if (!response.ok) throw new ApiError(response.status, 'push is not configured')
  return (await response.json()) as { key: string }
}

export async function subscribePush(subscription: unknown): Promise<void> {
  await post<void>('/api/push/subscribe', subscription)
}

export async function unsubscribePush(endpoint: string): Promise<void> {
  await post<void>('/api/push/unsubscribe', { endpoint })
}

export interface Health {
  ok: boolean
  lastSeq: number
  projectCount: number
  liveSessions: number
  agentReady: boolean
  pushReady: boolean
}

export async function fetchHealth(): Promise<Health> {
  const response = await fetch(`${BASE}/api/health`)
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return (await response.json()) as Health
}

// --- Files and editor (Phase 3) --------------------------------------------

const fsUrl = (projectId: string, sub: string, query: Record<string, string> = {}): string => {
  const qs = new URLSearchParams(query).toString()
  return `${BASE}/api/projects/${encodeURIComponent(projectId)}/${sub}${qs ? `?${qs}` : ''}`
}

/** One level of a project's file tree. `path` empty/omitted fetches the repo root — the tree is browsed lazily, never walked all at once. */
export async function fetchFileTree(projectId: string, path = ''): Promise<FsTreeResponse> {
  const response = await fetch(fsUrl(projectId, 'fs/tree', path ? { path } : {}))
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return (await response.json()) as FsTreeResponse
}

/** A single text file's contents. Read-only for v1 (PHASE-3.md design call 7). */
export async function fetchFileContent(projectId: string, path: string): Promise<FsFileResponse> {
  const response = await fetch(fsUrl(projectId, 'fs/file', { path }))
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return (await response.json()) as FsFileResponse
}

/** ripgrep-backed content search across the project. */
export async function searchProjectFiles(projectId: string, query: string): Promise<FsSearchResponse> {
  const response = await fetch(fsUrl(projectId, 'fs/search', { q: query }))
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return (await response.json()) as FsSearchResponse
}

/** Working-tree-vs-HEAD changed files, for the read-only Source control view (staging/commit/push stay Phase 6). */
export async function fetchGitStatus(projectId: string): Promise<GitStatusResponse> {
  const response = await fetch(`${BASE}/api/projects/${encodeURIComponent(projectId)}/git/status`)
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return (await response.json()) as GitStatusResponse
}
