/**
 * 文件与工作区共用的精确文本替换。
 *
 * 只做纯文本计算，不碰文件系统、权限或审批；调用方负责范围校验、读取
 * 前置条件、备份与写入。两种调用语义由 `replaceAll` 显式表达：
 * - 工作区 `ws_replace` 只允许唯一匹配（replaceAll=false 且多处匹配失败）；
 * - 作品编辑允许用户显式开启全部替换。
 */
export type TextEditFailure = 'empty-old-text' | 'no-match' | 'ambiguous'

export type TextEditResult =
  | { ok: true; text: string; count: number }
  | { ok: false; reason: TextEditFailure; count: number }

export function applyExactTextEdit(
  text: string,
  oldText: string,
  newText: string,
  options: { replaceAll?: boolean } = {}
): TextEditResult {
  if (oldText === '') return { ok: false, reason: 'empty-old-text', count: 0 }
  const count = text.split(oldText).length - 1
  if (count === 0) return { ok: false, reason: 'no-match', count: 0 }
  if (count > 1 && options.replaceAll !== true) {
    return { ok: false, reason: 'ambiguous', count }
  }
  return {
    ok: true,
    count,
    text:
      options.replaceAll === true
        ? text.split(oldText).join(newText)
        : replaceFirst(text, oldText, newText)
  }
}

/** 只替换第一处；供审批预览使用，不判断唯一性。 */
export function replaceFirstText(text: string, oldText: string, newText: string): string {
  return replaceFirst(text, oldText, newText)
}

function replaceFirst(text: string, oldText: string, newText: string): string {
  const first = text.indexOf(oldText)
  return text.slice(0, first) + newText + text.slice(first + oldText.length)
}
