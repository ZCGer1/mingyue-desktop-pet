/**
 * 连续感知的纯本地帧工具。
 *
 * 这里不依赖 Electron：调用方把 `nativeImage.toBitmap()` 的 BGRA 像素传进来，
 * 得到可比较的 64 位 dHash 与亮度/方差。原始 JPEG 只保存在调用方的短期内存
 * 里；本模块不写盘、不记录日志，也不再为常规感知保留视频式帧环。
 */

export interface FrameSample {
  /** 64 个字符的 0/1 位串；不同画面之间可用汉明距离比较。 */
  signature: string
  brightness: number
  variance: number
  black: boolean
  lowResolution: boolean
}

export interface FrameQuality {
  quality: 'good' | 'low' | 'black'
  static: boolean
  changeScore: number
}

/** 从 BGRA 位图抽样出 dHash 与亮度统计。 */
export function sampleFrame(
  bitmap: Buffer,
  width: number,
  height: number
): FrameSample {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  if (bitmap.length < w * h * 4) {
    return {
      signature: '0'.repeat(64),
      brightness: 0,
      variance: 0,
      black: true,
      lowResolution: true
    }
  }

  // 9x8 网格的中心点做水平差分，得到 64 位 dHash；对镜头整体移动/缩放
  // 比逐像素哈希稳定，同时仍能感知画面结构变化。
  const gray = new Float32Array(9 * 8)
  for (let gy = 0; gy < 8; gy += 1) {
    const y = Math.min(h - 1, Math.floor(((gy + 0.5) * h) / 8))
    for (let gx = 0; gx < 9; gx += 1) {
      const x = Math.min(w - 1, Math.floor(((gx + 0.5) * w) / 9))
      const offset = (y * w + x) * 4
      const b = bitmap[offset] ?? 0
      const g = bitmap[offset + 1] ?? 0
      const r = bitmap[offset + 2] ?? 0
      gray[gy * 9 + gx] = 0.114 * b + 0.587 * g + 0.299 * r
    }
  }
  let bits = ''
  for (let gy = 0; gy < 8; gy += 1) {
    for (let gx = 0; gx < 8; gx += 1) {
      bits += gray[gy * 9 + gx]! > gray[gy * 9 + gx + 1]! ? '1' : '0'
    }
  }

  // 亮度/方差用 32x18 网格，避免单点噪声把黑屏判定带偏。
  let sum = 0
  let sumSq = 0
  let count = 0
  const cols = 32
  const rows = 18
  for (let gy = 0; gy < rows; gy += 1) {
    const y = Math.min(h - 1, Math.floor(((gy + 0.5) * h) / rows))
    for (let gx = 0; gx < cols; gx += 1) {
      const x = Math.min(w - 1, Math.floor(((gx + 0.5) * w) / cols))
      const offset = (y * w + x) * 4
      const b = bitmap[offset] ?? 0
      const g = bitmap[offset + 1] ?? 0
      const r = bitmap[offset + 2] ?? 0
      const value = 0.114 * b + 0.587 * g + 0.299 * r
      sum += value
      sumSq += value * value
      count += 1
    }
  }
  const brightness = count === 0 ? 0 : sum / count
  const variance = count === 0 ? 0 : Math.max(0, sumSq / count - brightness * brightness)
  return {
    signature: bits,
    brightness: Math.round(brightness * 10) / 10,
    variance: Math.round(variance * 10) / 10,
    black: brightness < 10 && variance < 10,
    lowResolution: w < 640 || h < 360
  }
}

/** 汉明距离（0–64）；0 表示完全相同的结构。 */
export function signatureDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64
  let distance = 0
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) distance += 1
  }
  return distance
}

export function frameChangeScore(previous: FrameSample | null, next: FrameSample): number {
  if (previous === null) return 0
  if (next.black && !previous.black) return 1
  return Math.min(1, signatureDistance(previous.signature, next.signature) / 32)
}

/**
 * 画质判定。`frozen` 不在这里判断——冻结需要时间维度，由帧环的
 * `isFrozen` 完成，避免单帧相同就误报。
 */
export function frameQuality(previous: FrameSample | null, next: FrameSample): FrameQuality {
  const changeScore = frameChangeScore(previous, next)
  return {
    quality: next.black ? 'black' : next.lowResolution ? 'low' : 'good',
    static: changeScore < 0.12,
    changeScore: Math.round(changeScore * 1000) / 1000
  }
}

/**
 * OCR 结构化摘要：只用于本地比较 HUD/文字结构是否变化，不保存原文。
 * 连续变化的数字（弹药、血量、计时）归一化为 #，避免把每一次 HUD 数值
 * 刷新都当成语义变化。
 */
export function ocrSignature(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/\s+/g, ' ')
        .replace(/\d+(?:[.:]\d+)*/g, '#')
        .trim()
    )
    .filter((line) => line.length >= 2)
    .slice(0, 24)
    .map((line) => line.slice(0, 80))
  const normalized = lines.join('\u0001').toLowerCase()
  let hash = 0x811c9dc5
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 只保留可安全写进本地诊断的 OCR 计数，不含任何原文。 */
export function ocrLineCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '').length
}
