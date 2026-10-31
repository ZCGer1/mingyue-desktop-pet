#!/usr/bin/env node
/**
 * 打包产物校验（`npm run verify:packaged-pet`，由 `pack`/`dist` 自动调用）。
 *
 * 背景：动画 WebM 使用中文文件名。若把它们放在 `extraResources`，Windows 下
 * electron-builder 生成 portable/NSIS 的 7z 归档时会静默丢掉这些条目，安装后
 * `webm/` 为空、桌宠页 404。现在素材通过 `files` 打进 app.asar；本脚本确认
 * 每个被目录引用的动画都真实存在于 `release/win-unpacked/resources/app.asar`。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogRefs } from './dsh-pet-catalog-lib.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 可选首参数指定独立构建目录；默认仍校验 release。
const releaseRoot = resolve(root, process.argv[2] ?? 'release')
const asarPath = join(releaseRoot, 'win-unpacked', 'resources', 'app.asar')
const catalogPath = join(root, 'vendor', 'dsh-pet', 'assets', 'catalog.json')

if (!existsSync(asarPath)) {
  console.error(`[packaged-pet] 缺少打包产物：${asarPath}`)
  process.exit(1)
}

let catalog
try {
  catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
} catch (error) {
  console.error(`[packaged-pet] 无法读取动画目录：${String(error)}`)
  process.exit(1)
}

const expected = catalogRefs(catalog)
const entries = new Set(
  asar
    .listPackage(asarPath)
    .map((entry) => entry.replace(/\\/g, '/'))
    .filter((entry) => entry.endsWith('.webm'))
)

const missing = []
for (const id of expected) {
  const entry = `/vendor/dsh-pet/assets/webm/${id}.webm`
  if (!entries.has(entry)) missing.push(id)
}

if (missing.length > 0) {
  console.error(
    `[packaged-pet] app.asar 缺少 ${missing.length}/${expected.length} 个动画素材：` +
      `${missing.slice(0, 5).join('、')}${missing.length > 5 ? '…' : ''}`
  )
  process.exit(1)
}

// 浏览器扩展模板位于 extraResources/browser-extension，运行时由
// BrowserExtensionManager 复制到稳定数据目录。这里确认打包产物确实包含
// manifest 引用的入口文件，并且没有混入本地配对/用户数据。
const extensionRoot = join(releaseRoot, 'win-unpacked', 'resources', 'browser-extension')
const extensionManifestPath = join(extensionRoot, 'manifest.json')
if (!existsSync(extensionManifestPath)) {
  console.error(`[packaged-pet] 缺少浏览器扩展模板：${extensionManifestPath}`)
  process.exit(1)
}

let extensionManifest
try {
  extensionManifest = JSON.parse(readFileSync(extensionManifestPath, 'utf8'))
} catch (error) {
  console.error(`[packaged-pet] 浏览器扩展 manifest 无法解析：${String(error)}`)
  process.exit(1)
}

function isSafeManifestRef(ref) {
  if (typeof ref !== 'string' || ref.trim() === '') return false
  const normalized = ref.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false
  return !normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
}

function extensionRefs(manifest) {
  const refs = []
  const add = (ref) => {
    if (typeof ref === 'string') refs.push(ref)
  }
  add(manifest?.background?.service_worker)
  add(manifest?.action?.default_popup)
  add(manifest?.options_ui?.page)
  for (const script of manifest?.content_scripts ?? []) {
    for (const ref of script?.js ?? []) add(ref)
    for (const ref of script?.css ?? []) add(ref)
  }
  return refs
}

const refs = extensionRefs(extensionManifest)
if (extensionManifest?.manifest_version !== 3 || refs.length === 0) {
  console.error('[packaged-pet] 浏览器扩展 manifest 不是可用的 MV3 扩展')
  process.exit(1)
}

const missingExtensionRefs = []
for (const ref of refs) {
  if (!isSafeManifestRef(ref)) {
    missingExtensionRefs.push(`${ref}（非法路径）`)
    continue
  }
  const target = join(extensionRoot, ...ref.split('/'))
  const rel = relative(extensionRoot, target)
  if (rel.startsWith('..') || !existsSync(target)) missingExtensionRefs.push(ref)
}
if (missingExtensionRefs.length > 0) {
  console.error(
    `[packaged-pet] 浏览器扩展模板缺少 manifest 引用文件：${missingExtensionRefs.join('、')}`
  )
  process.exit(1)
}

const forbiddenExtensionFiles = []
const forbiddenNames = new Set([
  'browser-bridge.json',
  'token.json',
  'pairing-token.js',
  'browser-bridge.js'
])
const walkExtension = (dir, prefix = '') => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (['data', 'logs', 'secrets', 'user-data'].includes(entry.name)) {
        forbiddenExtensionFiles.push(`${rel}/`)
        continue
      }
      walkExtension(join(dir, entry.name), rel)
      continue
    }
    const lower = entry.name.toLowerCase()
    if (
      forbiddenNames.has(lower) ||
      lower.startsWith('.') ||
      ['.pem', '.key', '.sqlite', '.sqlite3', '.log'].includes(extname(lower))
    ) {
      forbiddenExtensionFiles.push(rel)
    }
  }
}
walkExtension(extensionRoot)
if (forbiddenExtensionFiles.length > 0) {
  console.error(
    `[packaged-pet] 浏览器扩展模板混入了用户数据/配对文件：${forbiddenExtensionFiles.join('、')}`
  )
  process.exit(1)
}

console.log(
  `[packaged-pet] 校验通过：app.asar 内含全部 ${expected.length} 个动画 WebM（共 ${entries.size} 个）；` +
    `浏览器扩展模板含 manifest 引用的 ${refs.length} 个入口文件，未混入用户数据。`
)
