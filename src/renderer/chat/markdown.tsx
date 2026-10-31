import type { ReactNode } from 'react'

/**
 * 极小的安全 Markdown 渲染器（PLAN.md §6“渲染与链接”）。
 *
 * 刻意不引入会在内部拼 HTML 的库：
 *  - 所有内容都变成 React 文本节点，永远不设置 innerHTML；
 *  - 原始 HTML 会被当作普通文本显示；
 *  - 链接不生成 <a>，更不会调用任何打开外部程序的 API；
 *  - 代码块内容只读展示。
 */

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'hr' }
  | { kind: 'table'; header: string[]; rows: string[][] }

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i += 1
      continue
    }
    const fence = /^\s*```([\w.+-]*)\s*$/.exec(line)
    if (fence !== null) {
      const lang = (fence[1] ?? '').slice(0, 32)
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '')
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push({ kind: 'code', lang, text: body.join('\n') })
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' })
      i += 1
      continue
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr' })
      i += 1
      continue
    }
    if (/^\s{0,3}>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i] ?? '')) {
        quote.push((lines[i] ?? '').replace(/^\s{0,3}>\s?/, ''))
        i += 1
      }
      blocks.push({ kind: 'quote', lines: quote })
      continue
    }
    if (/^\s{0,3}[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s{0,3}[-*+]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s{0,3}[-*+]\s+/, ''))
        i += 1
      }
      blocks.push({ kind: 'ul', items })
      continue
    }
    if (/^\s{0,3}\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s{0,3}\d+[.)]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s{0,3}\d+[.)]\s+/, ''))
        i += 1
      }
      blocks.push({ kind: 'ol', items })
      continue
    }
    if (line.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      const header = splitTableRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(splitTableRow(lines[i] ?? ''))
        i += 1
      }
      blocks.push({ kind: 'table', header, rows })
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length) {
      const current = lines[i] ?? ''
      if (
        current.trim() === '' ||
        /^\s*```/.test(current) ||
        /^\s{0,3}#{1,6}\s+/.test(current) ||
        /^\s{0,3}[-*+]\s+/.test(current) ||
        /^\s{0,3}\d+[.)]\s+/.test(current) ||
        /^\s{0,3}>\s?/.test(current)
      ) {
        break
      }
      paragraph.push(current.trim())
      i += 1
    }
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
    else i += 1
  }
  return blocks
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]+)/g

/** 行内格式。链接只呈现文字与地址，不提供任何跳转动作。 */
export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let index = 0
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0
    if (start > last) nodes.push(text.slice(last, start))
    const token = match[0]
    const key = `${keyPrefix}-${index++}`
    if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      nodes.push(
        <code className="md-code" key={key}>
          {token.slice(1, -1)}
        </code>
      )
    } else if (/^https?:\/\//.test(token)) {
      nodes.push(
        <span className="md-link" key={key} title="链接不会在应用内打开">
          {token}
        </span>
      )
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
      if (link !== null) {
        nodes.push(
          <span className="md-link" key={key} title="链接不会在应用内打开">
            {link[1]}
            <span className="md-url"> （{truncateUrl(link[2] ?? '')}）</span>
          </span>
        )
      } else nodes.push(token)
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>)
    } else {
      nodes.push(token)
    }
    last = start + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function truncateUrl(url: string): string {
  return url.length > 120 ? `${url.slice(0, 120)}…` : url
}

export function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks = parseBlocks(text)
  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'code':
            return (
              <pre className="md-pre" key={index}>
                {block.lang !== '' && <span className="md-lang">{block.lang}</span>}
                <code>{block.text}</code>
              </pre>
            )
          case 'heading': {
            const level = Math.min(6, Math.max(1, block.level))
            const Tag = `h${level}` as 'h1'
            return (
              <Tag className={`md-h md-h${level}`} key={index}>
                {renderInline(block.text, `h${index}`)}
              </Tag>
            )
          }
          case 'paragraph':
            return (
              <p className="md-p" key={index}>
                {renderInline(block.text, `p${index}`)}
              </p>
            )
          case 'ul':
            return (
              <ul className="md-ul" key={index}>
                {block.items.map((item, i) => (
                  <li key={i}>{renderInline(item, `u${index}-${i}`)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol className="md-ol" key={index}>
                {block.items.map((item, i) => (
                  <li key={i}>{renderInline(item, `o${index}-${i}`)}</li>
                ))}
              </ol>
            )
          case 'quote':
            return (
              <blockquote className="md-quote" key={index}>
                {block.lines.map((line, i) => (
                  <p key={i}>{renderInline(line, `q${index}-${i}`)}</p>
                ))}
              </blockquote>
            )
          case 'hr':
            return <hr className="md-hr" key={index} />
          case 'table':
            return (
              <div className="md-table-wrap" key={index}>
                <table className="md-table">
                  <thead>
                    <tr>
                      {block.header.map((cell, i) => (
                        <th key={i}>{renderInline(cell, `th${index}-${i}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c}>{renderInline(cell, `td${index}-${r}-${c}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        }
      })}
    </div>
  )
}

/** 统一 diff 展示。只做着色，不做解析或执行。 */
export function DiffView({ diff }: { diff: string }): React.JSX.Element {
  return (
    <pre className="diff-view">
      {diff.split(/\r?\n/).map((line, index) => {
        let className = 'diff-line'
        if (line.startsWith('@@')) className += ' diff-hunk'
        else if (line.startsWith('+++') || line.startsWith('---')) className += ' diff-file'
        else if (line.startsWith('+')) className += ' diff-add'
        else if (line.startsWith('-')) className += ' diff-del'
        return (
          <span className={className} key={index}>
            {line === '' ? ' ' : line}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}
