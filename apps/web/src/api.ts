import type {
  ApprovalRequest,
  CreateProjectRequest,
  CreateProjectResponse,
  GithubRepo,
  GithubReposResponse,
  NameCheckResponse,
  NewThreadResponse,
  FileDiffResponse,
  Project,
  ProjectsResponse,
  PromptRequest,
  PromptResponse,
  RenameThreadRequest,
  Thread,
  ThreadsResponse,
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

export const eventStreamUrl = (): string => `${BASE}/api/events`

/** SSE of a project's live setup output (clone + install). */
export const buildStreamUrl = (projectId: string): string =>
  `${BASE}/api/projects/${encodeURIComponent(projectId)}/build`

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
export async function sendPrompt(text: string, projectId: string, threadId: string): Promise<PromptResponse> {
  return (await post<PromptResponse>('/api/prompt', { text, projectId, threadId } satisfies PromptRequest))!
}

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

/**
 * Clone (repoUrl) or create (name). Returns 202 with the projectId; watch the
 * event stream for `project_created` / `project_create_failed`, since a clone
 * is slow.
 */
export async function createProject(body: CreateProjectRequest): Promise<CreateProjectResponse> {
  return (await post<CreateProjectResponse>('/api/projects', body))!
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

/** Resolves the promise `canUseTool` is parked on. 409 if already decided or expired. */
export async function decideApproval(
  approvalId: string,
  allow: boolean,
  reason?: string,
): Promise<void> {
  await post<void>(`/api/approvals/${encodeURIComponent(approvalId)}`, {
    allow,
    ...(reason ? { reason } : {}),
  } satisfies ApprovalRequest)
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
