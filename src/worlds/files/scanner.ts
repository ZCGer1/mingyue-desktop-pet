/**
 * 文件扩展名分类的轻量工具。
 *
 * 后台随机抽样已退役；这里只保留主动读取/编辑仍在使用的文本可读性判断。
 * PDF/Office/EPUB 等文档由 `documents.ts` 按需解析文本层，不走本判断。
 */
const TEXT_READABLE = new Set([
  '.md', '.markdown', '.txt', '.log', '.csv', '.tsv', '.json', '.jsonc', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.xml', '.rst', '.org',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.c', '.h',
  '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.sql', '.html', '.css', '.scss',
  '.less', '.vue', '.svelte', '.lua', '.kt', '.swift', '.dart', '.ex', '.exs',
  '.svg'
])

export function isTextReadable(ext: string): boolean {
  return TEXT_READABLE.has(ext.toLowerCase())
}
