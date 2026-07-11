import type { GithubRepo, Visibility } from '@mce/protocol'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Runs a `gh` command and returns stdout. Injectable so tests never shell out
 * and never touch a real GitHub account.
 */
export type GhRun = (args: string[]) => Promise<string>

const defaultGh: GhRun = async (args) => {
  const { stdout } = await execFileAsync('gh', args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

/** Thin wrapper over the `gh` CLI, which authenticates from GH_TOKEN in the container. */
export class Github {
  readonly #gh: GhRun
  #login: string | undefined

  constructor(gh: GhRun = defaultGh) {
    this.#gh = gh
  }

  /** The authenticated account login, cached. Throws if gh isn't available/authed. */
  async login(): Promise<string> {
    if (this.#login) return this.#login
    const out = await this.#gh(['api', '/user', '--jq', '.login'])
    this.#login = out.trim()
    if (!this.#login) throw new Error('gh: could not determine the authenticated user')
    return this.#login
  }

  /**
   * Repos the user owns or belongs to, filtered by `query`, owned ones first.
   * `--jq` with `.[]` emits one JSON object per line.
   */
  async listRepos(query: string): Promise<GithubRepo[]> {
    const login = await this.login().catch(() => '')
    const out = await this.#gh([
      'api',
      '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
      '--jq',
      '.[] | {nameWithOwner: .full_name, owner: .owner.login, description: .description, private: .private, url: .html_url, cloneUrl: .clone_url}',
    ])

    const repos = out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Omit<GithubRepo, 'isOwn'>)

    const q = query.trim().toLowerCase()
    const matched = q
      ? repos.filter(
          (r) =>
            r.nameWithOwner.toLowerCase().includes(q) ||
            (r.description ?? '').toLowerCase().includes(q),
        )
      : repos

    return matched
      .map((r) => ({ ...r, isOwn: r.owner === login }))
      .sort((a, b) => Number(b.isOwn) - Number(a.isOwn))
      .slice(0, 8)
  }

  /** Does `owner/name` already exist on GitHub? */
  async repoExists(name: string): Promise<boolean> {
    const owner = await this.login()
    try {
      await this.#gh(['api', `/repos/${owner}/${encodeURIComponent(name)}`, '--silent'])
      return true
    } catch {
      return false // 404 → available
    }
  }

  /** Create a new repo under the user's account. Returns its https clone URL. */
  async createRepo(name: string, visibility: Visibility): Promise<string> {
    const owner = await this.login()
    // Create only — the clone is done by ProjectStore into the exact directory.
    await this.#gh(['repo', 'create', name, `--${visibility}`])
    return `https://github.com/${owner}/${name}.git`
  }
}
