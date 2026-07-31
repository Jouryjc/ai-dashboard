import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

function requiredDirectory(name) {
  const raw = process.env[name]
  if (!raw) throw new Error(`缺少受控构建参数：${name}`)
  const resolved = fs.realpathSync(raw)
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`受控构建参数不是目录：${name}`)
  }
  return resolved
}

const projectRoot = requiredDirectory('IDUX_BUILD_PROJECT_ROOT')
const outputRoot = path.resolve(process.env.IDUX_BUILD_OUTPUT_ROOT || '')
const nodeModules = requiredDirectory('IDUX_BUILD_NODE_MODULES')

if (!outputRoot || outputRoot === path.parse(outputRoot).root) {
  throw new Error('受控构建输出目录不安全')
}

const packageEntry = (name, entry = 'index.js') => path.join(nodeModules, name, entry)
const packageSubpath = (name) => `${path.join(nodeModules, name)}${path.sep}$1`

export default defineConfig({
  root: projectRoot,
  base: './',
  publicDir: false,
  plugins: [vue()],
  resolve: {
    dedupe: ['vue'],
    alias: [
      { find: /^vue$/, replacement: packageEntry('vue', 'dist/vue.esm-bundler.js') },
      { find: /^@idux\/components$/, replacement: packageEntry('@idux/components') },
      { find: /^@idux\/components\/(.+)$/, replacement: packageSubpath('@idux/components') },
      { find: /^@idux\/cdk$/, replacement: packageEntry('@idux/cdk') },
      { find: /^@idux\/cdk\/(.+)$/, replacement: packageSubpath('@idux/cdk') }
    ]
  },
  build: {
    outDir: outputRoot,
    emptyOutDir: true,
    sourcemap: false,
    minify: 'esbuild',
    target: 'es2022',
    assetsInlineLimit: 4096,
    reportCompressedSize: false
  },
  logLevel: 'info',
  clearScreen: false
})
