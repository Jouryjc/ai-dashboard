import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dirs } from '../store'
import { skillRegistry } from './registry'

const TIMEOUT_MS = Number(process.env.IDUX_CLI_TIMEOUT_MS ?? 20_000)
const MAX_OUTPUT_BYTES = Number(process.env.IDUX_CLI_MAX_OUTPUT_BYTES ?? 2 * 1024 * 1024)
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/
const SAFE_SECTION = /^[A-Za-z][A-Za-z0-9-]{0,127}$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export interface IduxEvidence<T = unknown> {
  skill: 'idux-cli'
  command: 'versions' | 'list' | 'info' | 'demo'
  args: string[]
  payload: T
  sha256: string
  capturedAt: number
}

function cliEntry(): string {
  const candidates = [
    process.env.IDUX_CLI_ENTRY,
    path.resolve(process.cwd(), 'node_modules/idux-cli/bin/idux-cli.js'),
    path.resolve(process.cwd(), '../../idux-cli/bin/idux-cli.js')
  ].filter((candidate): candidate is string => Boolean(candidate))
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new Error('找不到 idux-cli，可通过 IDUX_CLI_ENTRY 指定受信任的入口文件')
  }
  return fs.realpathSync(found)
}

function allowedRoots(): string[] {
  const configured = (process.env.IDUX_ALLOWED_PROJECT_ROOTS ?? '')
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean)
  return [dirs.workspaces, ...configured].map((root) => path.resolve(root))
}

function assertAllowedProjectRoot(projectRoot: string): string {
  const resolved = fs.realpathSync(projectRoot)
  const allowed = allowedRoots().some((root) => {
    const relative = path.relative(root, resolved)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
  if (!allowed) throw new Error(`idux-cli 不允许访问这个项目目录：${resolved}`)
  return resolved
}

function assertVersion(version: string | undefined): void {
  if (version !== undefined && version !== 'bundled' && !EXACT_VERSION.test(version)) {
    throw new Error(`IDux 版本必须是精确版本：${version}`)
  }
}

function safeEnv(): NodeJS.ProcessEnv {
  const names = [
    'PATH',
    'Path',
    'SystemRoot',
    'TEMP',
    'TMP',
    'LOCALAPPDATA',
    'APPDATA',
    'IDUX_CLI_CACHE_DIR',
    'IDUX_VERSION'
  ]
  return Object.fromEntries(
    names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])
  )
}

async function run(
  projectRoot: string,
  command: IduxEvidence['command'],
  args: string[]
): Promise<IduxEvidence> {
  const skill = skillRegistry.get('idux-cli')
  if (
    skill.config.executionAdapter !== 'idux-cli' ||
    skill.config.permissions.process !== 'allowlisted' ||
    skill.config.permissions.network !== 'deny' ||
    !skill.config.allowedCommands.includes(command)
  ) {
    throw new Error(`idux-cli 命令未获授权：${command}`)
  }
  const cwd = assertAllowedProjectRoot(projectRoot)
  const entry = cliEntry()
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, command, ...args], {
      cwd,
      env: safeEnv(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error?: Error, value?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value ?? '')
    }
    const append = (target: Buffer[], chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) {
        child.kill()
        finish(new Error(`idux-cli ${command} 输出超过安全上限`))
        return
      }
      target.push(chunk)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`idux-cli ${command} 执行超时`))
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => append(out, chunk))
    child.stderr.on('data', (chunk: Buffer) => append(err, chunk))
    child.once('error', (error) => {
      finish(error)
    })
    child.once('exit', (code) => {
      if (code !== 0) {
        finish(new Error(Buffer.concat(err).toString('utf8').trim() || `idux-cli ${command} 退出码 ${code}`))
        return
      }
      finish(undefined, Buffer.concat(out).toString('utf8').trim())
    })
  })
  let payload: unknown = stdout
  try {
    payload = JSON.parse(stdout)
  } catch {
    /* versions 是面向人的文本输出，原样保留。 */
  }
  return {
    skill: 'idux-cli',
    command,
    args,
    payload,
    sha256: crypto.createHash('sha256').update(stdout).digest('hex'),
    capturedAt: Date.now()
  }
}

function versionArgs(version?: string): string[] {
  assertVersion(version)
  return version ? ['--idux-version', version] : []
}

export const iduxCli = {
  versions(projectRoot: string): Promise<IduxEvidence<string>> {
    return run(projectRoot, 'versions', []) as Promise<IduxEvidence<string>>
  },

  list(projectRoot: string, keyword: string, version?: string): Promise<IduxEvidence> {
    if (!SAFE_NAME.test(keyword)) throw new Error(`组件关键词不合法：${keyword}`)
    return run(projectRoot, 'list', [keyword, '--json', ...versionArgs(version)])
  },

  info(
    projectRoot: string,
    component: string,
    section: string,
    options: { api?: string; version?: string } = {}
  ): Promise<IduxEvidence> {
    if (!SAFE_NAME.test(component)) throw new Error(`组件名不合法：${component}`)
    if (!SAFE_SECTION.test(section)) throw new Error(`API 分区不合法：${section}`)
    if (options.api && !SAFE_NAME.test(options.api)) throw new Error(`API 名不合法：${options.api}`)
    return run(projectRoot, 'info', [
      component,
      section,
      ...(options.api ? ['--api', options.api] : []),
      '--json',
      ...versionArgs(options.version)
    ])
  },

  demo(
    projectRoot: string,
    component: string,
    demoName?: string,
    version?: string
  ): Promise<IduxEvidence> {
    if (!SAFE_NAME.test(component)) throw new Error(`组件名不合法：${component}`)
    if (demoName && !SAFE_NAME.test(demoName)) throw new Error(`示例名不合法：${demoName}`)
    return run(projectRoot, 'demo', [
      component,
      ...(demoName ? [demoName] : ['--list']),
      '--json',
      ...versionArgs(version)
    ])
  }
}
