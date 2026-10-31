import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { toolContractCatalogText } from '../src/core/toolContract'

/**
 * 生成静态工具契约目录（PLAN-REVIEW-CONSOLIDATION §D）。
 *
 * 只写工具名、组归属与本地安全元数据；schema、示例和用户内容不进入文档。
 * 生成结果由 tests/unit/toolContract.test.ts 与源数据比对，防止手改漂移。
 */
const target = join(process.cwd(), 'docs', 'TOOL-CONTRACT.md')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, toolContractCatalogText(), 'utf8')
console.log(`已生成 ${target}`)
