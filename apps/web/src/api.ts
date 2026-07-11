import type {
  ApprovalRequest,
  CreateProjectRequest,
  CreateProjectResponse,
  Project,
  ProjectsResponse,
  PromptRequest,
  PromptResponse,
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
export async function sendPrompt(text: string, projectId: string, fresh?: boolean): Promise<PromptResponse> {
  return (await post<PromptResponse>('/api/prompt', {
    text,
    projectId,
    ...(fresh ? { fresh } : {}),
  } satisfies PromptRequest))!
}

/**
 * Ends the project's live session and draws a line in the log. The next prompt
 * to it starts a conversation Claude has no memory of.
 */
export async function startNewConversation(projectId: string): Promise<void> {
  await post<void>('/api/conversations/new', { projectId })
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
