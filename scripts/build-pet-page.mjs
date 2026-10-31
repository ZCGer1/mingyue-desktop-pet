// 构建桌宠页：esbuild 把 main.tsx（含内嵌聊天面板的 React）打成 IIFE，
// 同时把 chat/styles.css 与 pet-page/app.css 合并输出为 app.css。
// 产物全部在 resources/pet-page，由 PetHostServer 以只读方式提供。
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'src', 'pet-page')
const outDir = join(root, 'resources', 'pet-page')

// app.css 由 esbuild 从 CSS import 生成，不能从源码复制（会覆盖构建产物）。
const staticFiles = ['index.html', 'favicon.svg']
// 旧 Live2D 页面的静态资源；构建时清掉，避免从既有构建目录里误加载。
const staleEntries = ['runtime.js', 'react', 'spike.html', 'spike.js']

async function main() {
  await mkdir(outDir, { recursive: true })
  for (const entry of staleEntries) {
    await rm(join(outDir, entry), { recursive: true, force: true })
  }
  for (const file of staticFiles) {
    await copyFile(join(sourceDir, file), join(outDir, file))
  }

  await build({
    entryPoints: [join(sourceDir, 'main.tsx')],
    outfile: join(outDir, 'app.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome130',
    jsx: 'automatic',
    loader: { '.css': 'css' },
    define: {
      'process.env.NODE_ENV': '"production"'
    },
    charset: 'utf8',
    legalComments: 'none',
    sourcemap: false,
    logLevel: 'warning'
  })

  const bundle = await stat(join(outDir, 'app.js'))
  const css = await stat(join(outDir, 'app.css'))
  console.log(
    `[pet-page] built resources/pet-page/app.js (${Math.round(bundle.size / 1024)} KiB) + ` +
      `app.css (${Math.round(css.size / 1024)} KiB) and ${staticFiles.length} static files`
  )
}

main().catch((error) => {
  console.error('[pet-page] build failed:', error)
  process.exitCode = 1
})
