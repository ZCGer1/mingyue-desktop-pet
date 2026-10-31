/**
 * dsh-pet 动画目录生成/校验的共享实现（构建脚本专用，不进入应用运行时）。
 *
 * 目录唯一来源：vendor/dsh-pet/assets/config.jsonc 中默认实例 + animations/
 * animationWeights/physics。所有被引用的 WebM 都必须真实存在、非空且带 EBML
 * 魔数；生成结果是 `src/shared/dshPet/catalog.generated.ts`（运行时）与
 * `vendor/dsh-pet/assets/catalog.json`（审计/诊断），两者逐字节可重建。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
const DEFAULT_PET_ID = 'main'

/** 去掉 JSONC 注释和尾逗号（字符串内的 // 不会被误删）。 */
export function parseJsonc(source) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i++
      continue
    }
    out += ch
  }
  out = out.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(out)
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 必须是非空字符串`)
  }
  return value
}

function requirePositiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} 必须是正数`)
  }
  return value
}

function asStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} 必须是非空数组`)
  }
  for (const item of value) requireString(item, `${label}[]`)
  return [...value]
}

function flattenSlot(slot, label) {
  if (typeof slot === 'string') return [requireString(slot, label)]
  if (Array.isArray(slot) && slot.length > 0) {
    return slot.map((item) => requireString(item, `${label}[]`))
  }
  throw new Error(`${label} 必须是动画名或非空候选数组`)
}

/** 从 config.jsonc 构造唯一运行时目录（只保留已经被上游选择器消费的字段）。 */
export function buildCatalog(config) {
  const animations = config?.animations
  if (!animations || typeof animations !== 'object') throw new Error('config.animations 缺失')
  const pet = Array.isArray(config.pets)
    ? config.pets.find((item) => item?.id === DEFAULT_PET_ID)
    : undefined
  if (!pet) throw new Error(`默认实例 pets[id=${DEFAULT_PET_ID}] 不存在`)

  const movesRaw = animations.moves
  if (!movesRaw || typeof movesRaw !== 'object') throw new Error('animations.moves 缺失')
  const moveDefault = {
    minDist: requirePositiveNumber(movesRaw.default?.minDist, 'moves.default.minDist'),
    maxDist: requirePositiveNumber(movesRaw.default?.maxDist, 'moves.default.maxDist'),
    margin: requirePositiveNumber(movesRaw.default?.margin, 'moves.default.margin'),
    leadSec: requirePositiveNumber(movesRaw.default?.leadSec, 'moves.default.leadSec'),
    tailSec: requirePositiveNumber(movesRaw.default?.tailSec, 'moves.default.tailSec')
  }
  const moveActions = (movesRaw.actions ?? []).map((action, index) => {
    const name = requireString(action?.name, `moves.actions[${index}].name`)
    const params = action?.params
    const out = { name }
    if (params !== undefined) {
      out.params = {}
      for (const key of ['minDist', 'maxDist', 'margin', 'leadSec', 'tailSec']) {
        if (params[key] !== undefined) {
          out.params[key] = requirePositiveNumber(params[key], `moves.actions[${index}].params.${key}`)
        }
      }
    }
    return out
  })

  const categories = (animations.categories ?? []).map((category, index) => {
    const out = {
      id: requireString(category?.id, `categories[${index}].id`),
      weight: requirePositiveNumber(category?.weight, `categories[${index}].weight`),
      actions: asStringArray(category?.actions, `categories[${index}].actions`)
    }
    if (category?.noMirror === true) out.noMirror = true
    return out
  })

  const events = {}
  for (const [key, pool] of Object.entries(animations.events ?? {})) {
    if (!Array.isArray(pool) || pool.length === 0) {
      throw new Error(`events.${key} 必须是非空数组`)
    }
    events[key] = pool.map((slot, index) => {
      const names = flattenSlot(slot, `events.${key}[${index}]`)
      return typeof slot === 'string' ? names[0] : names
    })
  }
  if (!Array.isArray(events.workStatus) || events.workStatus.length !== 6) {
    throw new Error('events.workStatus 必须严格包含 6 个档位')
  }

  const weights = config.animationWeights ?? {}
  const physics = config.physics ?? {}
  return {
    packId: DEFAULT_PET_ID,
    name: requireString(pet.name, 'pets[0].name'),
    baseSize: requirePositiveNumber(pet.size, 'pets[0].size'),
    animations: {
      idle: asStringArray(animations.idle, 'animations.idle'),
      turn: asStringArray(animations.turn, 'animations.turn'),
      drag: asStringArray(animations.drag, 'animations.drag'),
      clicks: asStringArray(animations.clicks, 'animations.clicks'),
      moves: { default: moveDefault, actions: moveActions },
      categories,
      events
    },
    weights: {
      idle: requirePositiveNumber(weights.idle, 'animationWeights.idle'),
      turn: requirePositiveNumber(weights.turn, 'animationWeights.turn'),
      move: requirePositiveNumber(weights.move, 'animationWeights.move')
    },
    physics: {
      gravity: requirePositiveNumber(physics.gravity, 'physics.gravity'),
      restitution: requirePositiveNumber(physics.restitution, 'physics.restitution'),
      groundFriction: requirePositiveNumber(physics.groundFriction, 'physics.groundFriction'),
      ceilingBounce: physics.ceilingBounce !== false,
      throwPower: requirePositiveNumber(physics.throwPower, 'physics.throwPower'),
      petCollision: physics.petCollision === true
    }
  }
}

/** 目录引用的全部动画名（去重、稳定顺序）。 */
export function catalogRefs(catalog) {
  const names = []
  const add = (name) => {
    if (typeof name === 'string' && !names.includes(name)) names.push(name)
  }
  for (const key of ['idle', 'turn', 'drag', 'clicks']) {
    for (const name of catalog.animations[key]) add(name)
  }
  for (const move of catalog.animations.moves.actions) add(move.name)
  for (const category of catalog.animations.categories) {
    for (const name of category.actions) add(name)
  }
  for (const pool of Object.values(catalog.animations.events)) {
    for (const slot of pool) {
      if (typeof slot === 'string') add(slot)
      else for (const name of slot) add(name)
    }
  }
  return names
}

/** 逐项校验素材：存在、非空、EBML 魔数。返回文件字节数合计。 */
export function validateAssets(assetDir, catalog) {
  const refs = catalogRefs(catalog)
  const missing = []
  const bad = []
  let bytes = 0
  for (const name of refs) {
    const file = join(assetDir, `${name}.webm`)
    if (!existsSync(file)) {
      missing.push(name)
      continue
    }
    const stat = statSync(file)
    if (!stat.isFile() || stat.size < 4) {
      bad.push(`${name}（空文件）`)
      continue
    }
    bytes += stat.size
    const fd = readFileSync(file, { encoding: null, flag: 'r' })
    if (!fd.subarray(0, 4).equals(EBML_MAGIC)) bad.push(`${name}（不是 WebM/EBML）`)
  }
  if (missing.length) throw new Error(`缺少素材：${missing.join('、')}`)
  if (bad.length) throw new Error(`素材损坏：${bad.join('、')}`)

  const files = readdirSync(assetDir).filter((file) => file.endsWith('.webm'))
  const referenced = new Set(refs.map((name) => `${name}.webm`))
  const unreferenced = files.filter((file) => !referenced.has(file))
  return { refs, files: files.length, bytes, unreferenced }
}

export function generatedSource(catalog) {
  const json = JSON.stringify(catalog, null, 2)
  return [
    '/**',
    ' * 由 scripts/build-dsh-pet-catalog.mjs 从 vendor/dsh-pet/assets/config.jsonc 生成。',
    ' * 不要手改；修改素材或配置后运行 `npm run build:dsh-pet-catalog`。',
    ' * 来源：PC2005-cloud/dsh-pet@2fa04a5133988a1ca901558e9a18f55845128b41（v0.3.8）。',
    ' */',
    "import type { DshPetCatalog } from './types'",
    '',
    `export const DSH_PET_CATALOG: DshPetCatalog = ${json}`,
    '',
    '/** 目录引用的全部动画 id（点播白名单）。 */',
    'export const DSH_PET_ANIMATION_IDS: readonly string[] = Array.from(',
    '  new Set([',
    '    ...DSH_PET_CATALOG.animations.idle,',
    '    ...DSH_PET_CATALOG.animations.turn,',
    '    ...DSH_PET_CATALOG.animations.drag,',
    '    ...DSH_PET_CATALOG.animations.clicks,',
    '    ...DSH_PET_CATALOG.animations.moves.actions.map((move) => move.name),',
    '    ...DSH_PET_CATALOG.animations.categories.flatMap((category) => category.actions),',
    '    ...Object.values(DSH_PET_CATALOG.animations.events).flatMap((pool) =>',
    '      pool.flatMap((slot) => (typeof slot === \'string\' ? [slot] : slot))',
    '    )',
    '  ])',
    ')',
    '',
    'export const DSH_PET_ANIMATION_ID_SET: ReadonlySet<string> = new Set(DSH_PET_ANIMATION_IDS)',
    ''
  ].join('\n')
}

export function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function readSha256Sums(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const entries = []
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line.trim())
    if (match) entries.push({ sha256: match[1], name: match[2] })
  }
  return entries
}
