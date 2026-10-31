#!/usr/bin/env node
/**
 * 从锁定上游默认配置生成可验证动画目录。
 *
 * 输出：
 *  - src/shared/dshPet/catalog.generated.ts（运行时唯一目录）
 *  - vendor/dsh-pet/assets/catalog.json（审计/诊断，不含素材内容）
 *
 * 任一被引用素材缺失、为空或不是 WebM 时失败，不生成半成品。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCatalog,
  generatedSource,
  parseJsonc,
  validateAssets
} from './dsh-pet-catalog-lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = join(root, 'vendor', 'dsh-pet', 'assets', 'config.jsonc')
const assetDir = join(root, 'vendor', 'dsh-pet', 'assets', 'webm')
const checksumFile = join(root, 'vendor', 'dsh-pet', 'assets', 'SHA256SUMS')
const generatedPath = join(root, 'src', 'shared', 'dshPet', 'catalog.generated.ts')
const catalogPath = join(root, 'vendor', 'dsh-pet', 'assets', 'catalog.json')

const config = parseJsonc(readFileSync(configPath, 'utf8'))
const catalog = buildCatalog(config)
const result = validateAssets(assetDir, catalog)
if (result.unreferenced.length > 0) {
  throw new Error(`存在未被默认配置引用的素材：${result.unreferenced.join('、')}`)
}
if (result.files !== result.refs.length) {
  throw new Error(`素材文件数 ${result.files} 与目录引用数 ${result.refs.length} 不一致`)
}
if (result.refs.length === 0) throw new Error('动画目录为空')
if (catalog.animations.idle.length === 0) throw new Error('idle 动画池为空')
if (!readFileSync(checksumFile, 'utf8').includes('  webm/')) {
  throw new Error('SHA256SUMS 缺失或格式异常')
}

writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
writeFileSync(generatedPath, generatedSource(catalog))
console.log(
  `[dsh-pet] 目录已生成：${result.refs.length} 个动画，${(result.bytes / 1024 / 1024).toFixed(1)} MiB；` +
    `pack=${catalog.packId}，角色=${catalog.name}`
)
