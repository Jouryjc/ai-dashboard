/**
 * business-app 受控构建器。
 *
 * 所有模型产物必须经过路径、体积、依赖、动态 API、外部地址和凭据检查后，才能进入隔离的 Vite 构建流程。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { dirs } from '../../store'
import type { ArtifactDraft } from '../types'

const BUILD_TIMEOUT_MS = Number(process.env.IDUX_BUILD_TIMEOUT_MS ?? 60_000)
const MAX_BUILD_OUTPUT_BYTES = Number(process.env.IDUX_BUILD_MAX_OUTPUT_BYTES ?? 2 * 1024 * 1024)
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_SOURCE_FILES = 64
const ALLOWED_FILE = /^(?:index\.html|package\.json|tsconfig\.json|vite\.config\.ts|generation-evidence\.json|src\/[A-Za-z0-9_./-]+\.(?:vue|ts|css|json))$/
const ALLOWED_IMPORT = /^(?:vue|vite|@vitejs\/plugin-vue|@idux\/components(?:\/[A-Za-z0-9_./-]+)?|@idux\/cdk(?:\/[A-Za-z0-9_./-]+)?|@idux\/pro(?:\/[A-Za-z0-9_./-]+)?)$/
const IMPORT_SPECIFIER = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g
const FORBIDDEN_RUNTIME_API = /\b(?:eval|Function|fetch|WebSocket|XMLHttpRequest|EventSource|SharedWorker|Worker)\s*(?:\(|\.)|sendBeacon\s*\(|window\.open\s*\(|(?:window\.)?location\.(?:assign|replace)\s*\(/i
const FORBIDDEN_SECRET = /\bsk-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*|(?:password|passwd|secret|token|api[_ -]?key|密码|密钥)\s*[:：=]\s*["']?[^\s"']{8,}/i

/** 构建输出目录、受限日志和耗时。 */
export interface BusinessAppBuildResult {
  outputDir: string
  log: string
  durationMs: number
}

/** 定位包含固定 Vite 与 IDux 依赖的服务端运行时根目录。 */
function runtimeRoot(): string {
  const candidates = [
    path.resolve(process.cwd()),
    path.resolve(__dirname, '../../..'),
    path.resolve(__dirname, '../../../../..')
  ]
  const found = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'node_modules', 'vite', 'bin', 'vite.js'))
  )
  if (!found) throw new Error('找不到服务端 IDux 构建运行时')
  return found
}

/** 返回受信任且不允许模型修改的 Vite 配置。 */
function trustedConfigFile(): string {
  const candidates = [
    path.join(runtimeRoot(), 'scripts', 'idux-vite.config.mjs'),
    path.resolve(process.cwd(), 'scripts/idux-vite.config.mjs')
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) throw new Error('找不到 IDux 受控构建配置')
  return fs.realpathSync(found)
}

/** 返回固定版本的 Vite CLI 入口。 */
function viteEntry(): string {
  const file = path.join(runtimeRoot(), 'node_modules', 'vite', 'bin', 'vite.js')
  if (!fs.existsSync(file)) throw new Error('服务端缺少固定版本的 Vite 构建运行时')
  return fs.realpathSync(file)
}

/** 返回构建时只读复用的服务端依赖目录。 */
function runtimeNodeModules(): string {
  const directory = path.join(runtimeRoot(), 'node_modules')
  if (!fs.existsSync(directory)) throw new Error('服务端构建依赖目录不存在')
  return fs.realpathSync(directory)
}

/** 规范化产物相对路径并阻止目录穿越。 */
function normalizeFileName(fileName: string): string {
  const normalized = fileName.replaceAll('\\', '/')
  if (
    !ALLOWED_FILE.test(normalized) ||
    normalized.startsWith('/') ||
    normalized.includes('../') ||
    path.posix.normalize(normalized) !== normalized
  ) {
    throw new Error(`业务应用包含不安全的文件路径：${fileName}`)
  }
  return normalized
}

/** 校验源码只能导入相对模块或受控依赖。 */
function validateImports(fileName: string, source: string): void {
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1] || match[2]
    if (specifier.startsWith('.')) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fileName), specifier))
      if (resolved === '..' || resolved.startsWith('../')) {
        throw new Error(`业务应用导入越出了源码目录：${fileName} -> ${specifier}`)
      }
      continue
    }
    if (!ALLOWED_IMPORT.test(specifier)) {
      throw new Error(`业务应用使用了未授权依赖：${specifier}`)
    }
  }
}

/** 对完整项目草稿执行构建前静态安全检查。 */
export function validateBusinessAppBuildInput(draft: ArtifactDraft): void {
  const entries = Object.entries(draft.files)
  if (entries.length === 0 || entries.length > MAX_SOURCE_FILES) {
    throw new Error(`业务应用源码文件数量必须在 1 到 ${MAX_SOURCE_FILES} 之间`)
  }
  let sourceBytes = 0
  for (const [rawName, source] of entries) {
    const fileName = normalizeFileName(rawName)
    sourceBytes += Buffer.byteLength(source, 'utf8')
    if (sourceBytes > MAX_SOURCE_BYTES) throw new Error('业务应用源码超过 2MB 安全上限')
    // generation-evidence.json 是不会被打包执行的来源元数据，其中两个官网地址由适配器单独校验。
    if (
      fileName !== 'generation-evidence.json' &&
      /\b(?:https?:|file:|data:text\/html|javascript:)/i.test(source)
    ) {
      throw new Error(`业务应用包含被禁止的外部或可执行 URL：${fileName}`)
    }
    if (FORBIDDEN_RUNTIME_API.test(source)) {
      throw new Error(`业务应用包含未授权的动态代码、网络或导航 API：${fileName}`)
    }
    if (FORBIDDEN_SECRET.test(source)) {
      throw new Error(`业务应用包含疑似凭据或密钥：${fileName}`)
    }
    validateImports(fileName, source)
  }
}

/** 仅继承构建必需环境变量，避免子进程读取模型密钥等服务端配置。 */
function safeBuildEnv(projectRoot: string, outputRoot: string): NodeJS.ProcessEnv {
  const inherited = ['SystemRoot', 'TEMP', 'TMP'].flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]]
  )
  return {
    ...Object.fromEntries(inherited),
    NODE_ENV: 'production',
    IDUX_BUILD_PROJECT_ROOT: projectRoot,
    IDUX_BUILD_OUTPUT_ROOT: outputRoot,
    IDUX_BUILD_NODE_MODULES: runtimeNodeModules()
  }
}

/** 确认项目目录真实位于服务端受控工作区。 */
function assertWorkspacePath(input: string): string {
  const resolved = fs.realpathSync(input)
  const relative = path.relative(path.resolve(dirs.workspaces), resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`构建目录不在受控工作区内：${resolved}`)
  }
  return resolved
}

/** 在受控子进程中构建业务应用，并限制时间和日志体积。 */
export async function buildBusinessApp(projectRoot: string, outputDir: string): Promise<BusinessAppBuildResult> {
  const safeProjectRoot = assertWorkspacePath(projectRoot)
  const safeOutputDir = path.resolve(outputDir)
  const outputRelative = path.relative(path.resolve(dirs.previews), safeOutputDir)
  if (outputRelative.startsWith('..') || path.isAbsolute(outputRelative)) {
    throw new Error(`构建输出不在预览目录内：${safeOutputDir}`)
  }
  fs.mkdirSync(path.dirname(safeOutputDir), { recursive: true })

  const startedAt = Date.now()
  const log = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [viteEntry(), 'build', '--config', trustedConfigFile()], {
      cwd: safeProjectRoot,
      env: safeBuildEnv(safeProjectRoot, safeOutputDir),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(Buffer.concat(chunks).toString('utf8').trim())
    }
    const append = (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BUILD_OUTPUT_BYTES) {
        child.kill()
        finish(new Error('业务应用构建日志超过安全上限'))
        return
      }
      chunks.push(chunk)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      if (code !== 0) {
        finish(new Error(Buffer.concat(chunks).toString('utf8').trim() || `业务应用构建失败，退出码 ${code}`))
        return
      }
      finish()
    })
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`业务应用构建超过 ${BUILD_TIMEOUT_MS / 1000} 秒安全上限`))
    }, BUILD_TIMEOUT_MS)
  })

  if (!fs.existsSync(path.join(safeOutputDir, 'index.html'))) {
    throw new Error('业务应用构建没有生成 index.html')
  }
  return { outputDir: safeOutputDir, log, durationMs: Date.now() - startedAt }
}
