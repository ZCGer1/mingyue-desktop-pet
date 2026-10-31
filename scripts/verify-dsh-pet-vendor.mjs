#!/usr/bin/env node
/**
 * vendor/dsh-pet 完整性校验（`npm run verify:dsh-pet`）。
 *
 * 校验项：
 *  1. UPSTREAM.json 固定 repo/commit/version，并记录 adopted 文件哈希；
 *  2. 所有 WebM 与 SHA256SUMS 一致（数量、字节数、SHA-256）；
 *  3. 默认配置引用全部存在、非空、EBML 魔数正确，且无未引用素材；
 *  4. catalog.json / catalog.generated.ts 可从 config.jsonc 逐字节重建；
 *  5. MIT LICENSE 与素材 NOTICE 均存在。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCatalog,
  generatedSource,
  hashFile,
  parseJsonc,
  readSha256Sums,
  validateAssets
} from './dsh-pet-catalog-lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'vendor', 'dsh-pet')
const assets = join(vendor, 'assets')
const webmDir = join(assets, 'webm')
const failures = []
const fail = (message) => failures.push(message)

const upstreamPath = join(vendor, 'UPSTREAM.json')
if (!existsSync(upstreamPath)) {
  fail('缺少 vendor/dsh-pet/UPSTREAM.json')
} else {
  const upstream = JSON.parse(readFileSync(upstreamPath, 'utf8'))
  if (upstream.repository !== 'https://github.com/PC2005-cloud/dsh-pet') {
    fail(`UPSTREAM.repository 异常：${String(upstream.repository)}`)
  }
  if (upstream.commit !== '2fa04a5133988a1ca901558e9a18f55845128b41') {
    fail(`UPSTREAM.commit 未锁定到预期值：${String(upstream.commit)}`)
  }
  if (upstream.version !== '0.3.8') fail(`UPSTREAM.version 异常：${String(upstream.version)}`)
  for (const file of upstream.adopted ?? []) {
    const path = join(vendor, file.path)
    if (!existsSync(path)) {
      fail(`adopted 文件缺失：${file.path}`)
      continue
    }
    const actual = hashFile(path)
    if (actual !== file.sha256) fail(`adopted 文件哈希不匹配：${file.path}`)
  }
  const license = upstream.license
  if (!license || typeof license !== 'object' || !String(license.code).includes('MIT')) {
    fail('UPSTREAM.license 未记录 MIT 代码许可')
  }
  if (!license || !String(license.assets).toLowerCase().includes('commercial')) {
    fail('UPSTREAM.license 未记录素材禁止商用限制')
  }
}

if (!existsSync(join(vendor, 'LICENSE'))) fail('缺少上游 LICENSE')
if (!existsSync(join(vendor, 'NOTICE-assets.md'))) fail('缺少素材 NOTICE-assets.md')

let catalog = null
try {
  const config = parseJsonc(readFileSync(join(assets, 'config.jsonc'), 'utf8'))
  catalog = buildCatalog(config)
  const assetsResult = validateAssets(webmDir, catalog)
  if (assetsResult.refs.length === 0) fail('动画目录为空')
  if (catalog.animations.idle.length === 0) fail('idle 动画池为空')
  if (assetsResult.unreferenced.length > 0) {
    fail(`存在未引用素材：${assetsResult.unreferenced.slice(0, 5).join('、')}`)
  }

  const sums = readSha256Sums(join(assets, 'SHA256SUMS'))
  if (sums.length !== assetsResult.files) {
    fail(`SHA256SUMS 数量 ${sums.length} != 素材文件数 ${assetsResult.files}`)
  }
  let totalBytes = 0
  for (const entry of sums) {
    const file = join(webmDir, entry.name.replace(/^.*[\\/]/, ''))
    if (!existsSync(file)) {
      fail(`SHA256SUMS 中的文件不存在：${entry.name}`)
      continue
    }
    totalBytes += readFileSync(file).byteLength
    if (hashFile(file) !== entry.sha256) fail(`素材哈希不匹配：${entry.name}`)
  }
  const upstream = existsSync(upstreamPath)
    ? JSON.parse(readFileSync(upstreamPath, 'utf8'))
    : null
  if (upstream?.assets) {
    if (upstream.assets.count !== assetsResult.files) {
      fail(`UPSTREAM.assets.count ${upstream.assets.count} != ${assetsResult.files}`)
    }
    if (upstream.assets.totalBytes !== totalBytes) {
      fail(`UPSTREAM.assets.totalBytes ${upstream.assets.totalBytes} != ${totalBytes}`)
    }
    if (upstream.assets.sha256File !== 'SHA256SUMS') {
      fail('UPSTREAM.assets.sha256File 未指向 assets/SHA256SUMS')
    }
    if (upstream.assets.directory !== 'assets/webm') {
      fail('UPSTREAM.assets.directory 未指向 assets/webm')
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

if (catalog !== null) {
  try {
    const expectedJson = `${JSON.stringify(catalog, null, 2)}\n`
    const actualJson = readFileSync(join(assets, 'catalog.json'), 'utf8')
    if (actualJson !== expectedJson) fail('catalog.json 与 config.jsonc 不同步，请重新生成')
    const expectedTs = generatedSource(catalog)
    const actualTs = readFileSync(join(root, 'src', 'shared', 'dshPet', 'catalog.generated.ts'), 'utf8')
    if (actualTs !== expectedTs) fail('catalog.generated.ts 与 config.jsonc 不同步，请重新生成')
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

if (failures.length > 0) {
  console.error(`[dsh-pet] 校验失败（${failures.length} 项）：`)
  for (const message of failures) console.error(`  - ${message}`)
  process.exit(1)
}
console.log('[dsh-pet] 校验通过：来源、106 个 WebM 哈希/魔数、默认配置引用与生成目录一致。')
