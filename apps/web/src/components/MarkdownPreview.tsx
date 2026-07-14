import { Loader } from 'lucide-react'
import { useEffect, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { fetchFileContent } from '../api.ts'

/**
 * Rendered (not raw) view of a markdown file, opened from the file tree's
 * per-row "Open preview" kebab action.
 *
 * Unlike the chat `Markdown` component — a deliberately tiny renderer for the
 * controlled subset Claude emits — real README files carry full GFM plus raw
 * embedded HTML (`<div align="center">`, `<img>`, tables, …). That's a solved
 * problem, so this leans on `react-markdown`: `remark-gfm` for tables/task
 * lists/strikethrough/autolinks, `rehype-raw` to actually render the embedded
 * HTML instead of printing the tags, and `rehype-sanitize` so an untrusted repo
 * can't smuggle a `<script>` through that raw-HTML door.
 */

// GitHub's sanitize schema, plus `align` so centered README logos/headings survive.
const SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'align'],
  },
}

// Tailwind-styled element overrides so the rendered markdown matches the app's
// dark theme. `node` (react-markdown's hast handle) is stripped from every
// component so it never lands on a DOM element as an unknown attribute.
const COMPONENTS: Components = {
  h1: ({ node, ...p }) => <h1 {...p} className="mb-3 mt-5 border-b border-line pb-1.5 text-[20px] font-semibold first:mt-0" />,
  h2: ({ node, ...p }) => <h2 {...p} className="mb-2.5 mt-5 border-b border-line pb-1 text-[17px] font-semibold first:mt-0" />,
  h3: ({ node, ...p }) => <h3 {...p} className="mb-2 mt-4 text-[15px] font-semibold" />,
  h4: ({ node, ...p }) => <h4 {...p} className="mb-2 mt-4 text-[14px] font-semibold" />,
  h5: ({ node, ...p }) => <h5 {...p} className="mb-1.5 mt-3 text-[13px] font-semibold" />,
  h6: ({ node, ...p }) => <h6 {...p} className="mb-1.5 mt-3 text-[12px] font-semibold text-muted" />,
  p: ({ node, ...p }) => <p {...p} className="my-2.5 leading-relaxed" />,
  a: ({ node, ...p }) => <a {...p} className="text-accent underline underline-offset-2" target="_blank" rel="noreferrer noopener" />,
  ul: ({ node, ...p }) => <ul {...p} className="my-2.5 list-disc space-y-1 pl-6" />,
  ol: ({ node, ...p }) => <ol {...p} className="my-2.5 list-decimal space-y-1 pl-6" />,
  li: ({ node, ...p }) => <li {...p} className="leading-relaxed marker:text-muted" />,
  blockquote: ({ node, ...p }) => <blockquote {...p} className="my-2.5 border-l-2 border-line pl-3 text-muted" />,
  hr: ({ node, ...p }) => <hr {...p} className="my-4 border-line" />,
  strong: ({ node, ...p }) => <strong {...p} className="font-semibold" />,
  em: ({ node, ...p }) => <em {...p} className="italic" />,
  img: ({ node, ...p }) => <img {...p} className="mx-auto my-2 h-auto max-w-full rounded" loading="lazy" />,
  pre: ({ node, ...p }) => (
    <pre
      {...p}
      className="my-3 overflow-x-auto rounded-md border border-line bg-panel-2 p-2.5 font-mono text-[12.5px] leading-snug [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit"
    />
  ),
  code: ({ node, ...p }) => <code {...p} className="rounded bg-panel-2 px-1 py-0.5 font-mono text-[0.9em]" />,
  table: ({ node, ...p }) => (
    <div className="my-3 overflow-x-auto">
      <table {...p} className="w-full border-collapse text-[13px]" />
    </div>
  ),
  th: ({ node, ...p }) => <th {...p} className="border border-line px-2.5 py-1.5 text-left font-semibold" />,
  td: ({ node, ...p }) => <td {...p} className="border border-line px-2.5 py-1.5" />,
}

export function MarkdownPreview({ projectId, path }: { projectId: string; path: string }): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(false)
    void fetchFileContent(projectId, path)
      .then((r) => !cancelled && setContent(r.content))
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [projectId, path])

  if (error) return <p className="p-4 text-center text-[13px] text-del">Couldn&rsquo;t load this file.</p>
  if (content === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted">
        <Loader className="size-4 animate-spin" />
        <span className="text-[13px]">Loading…</span>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 py-4 text-[14px] text-fg">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, SCHEMA]]}
          components={COMPONENTS}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
