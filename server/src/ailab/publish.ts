/**
 * AiLab 发布器 —— 把一个大屏版本 HTML 发布到 AiLab CodeBox，返回公网可访问的 URL。
 *
 * 链路（已验证，见 AILAB_PUBLISH.md）：
 *   ① init     幂等写凭据到 ~/.ailab-codebox/config.yaml
 *   ② list     查是否已有同名 CodeBox → 命中复用，否则 create
 *   ③ create   建容器（image-id 必填，codebox:v1.1 = 2）
 *   ④ open     写 SSH：~/.ssh/config managed block + 私钥 ~/.ssh/ailab-<name>
 *   ⑤ 上传     借 open 写好的 alias 用系统 ssh 免密上传 HTML 到 /workspace/index.html
 *   ⑥ 起服务   ssh 远程 pkill 旧进程 + nohup python3 -m http.server 9229 --bind 0.0.0.0
 *   ⑦ publish  把容器内 9229 暴露到公网，返回 public_url
 *
 * 所有外部命令调用走 runCli / runSsh（带超时、捕获输出）；任一步失败抛带大白话的 Error，
 * 由 orchestrator 接到走卡点流程。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PublishConfig } from '../wire'

/** ailab-codebox CLI 二进制目录（提交在仓库 server/bin/ailab-codebox/）。
 *  server 总从 server/ 目录运行（与 store.ts 的 DATA_DIR=process.cwd()/data 同假设）。 */
const BIN_DIR = resolve(process.cwd(), 'bin', 'ailab-codebox')

/** 按平台/架构选 CLI 二进制文件名（与 ailab-codebox skill 的平台映射一致） */
function cliBinaryName(): string {
  const { platform, arch } = process
  if (platform === 'win32') return 'ailab-codebox.exe'
  if (platform === 'darwin') return arch === 'arm64' ? 'ailab-codebox-darwin-arm64' : 'ailab-codebox-darwin-amd64'
  return 'ailab-codebox' // linux x86_64
}

/** 完整 CLI 路径（dev 跑 tsx 时是 src/ 编译后是 dist/，都向上两级到 server/bin） */
function cliPath(): string {
  return join(BIN_DIR, cliBinaryName())
}

/** 凭据配置文件 ~/.ailab-codebox/config.yaml */
const CFG_FILE = join(homedir(), '.ailab-codebox', 'config.yaml')

/** AI 大屏工作台默认用的镜像 id（codebox:v1.1，经实测自带 python3 + node） */
const CODEBOX_IMAGE_ID = 2

/** 默认 CodeBox 规格（与 ailab-codebox skill 默认值一致） */
const DEFAULT_CPU = 1
const DEFAULT_MEMORY = 2048
const DEFAULT_STORAGE = 20

/** 容器内静态服务端口（create 时自动预置的 debug 端口） */
const SERVE_PORT = 9229

/** 发布结果 */
export interface PublishResult {
  /** 公网可访问的 URL，如 http://59.37.133.154:20012 */
  publicUrl: string
  /** AiLab 返回的完整 publish 信息（调试/详情用） */
  detail: {
    publicHost?: string
    publicAddress?: string
    hostPort?: number
    containerPort?: number
  }
}

/** CLI / ssh 调用失败 */
export class PublishError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'PublishError'
  }
}

/* ------------------------------ 底层：子进程执行 ------------------------------ */

/** 读 config.yaml 里的字段值（幂等 init 判断用）。文件不存在或缺字段返回空串。 */
function readCfgField(key: string): string {
  if (!existsSync(CFG_FILE)) return ''
  const m = new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, 'm').exec(readFileSync(CFG_FILE, 'utf8'))
  return m ? m[1] : ''
}

/** 同步跑 ailab-codebox CLI，返回 JSON 结果。非零退出/超时/非 JSON 抛 PublishError。 */
function runCli(args: string[], opts: { timeout?: number; stage?: string } = {}): Record<string, unknown> {
  const cli = cliPath()
  if (!existsSync(cli)) {
    throw new PublishError(`发布用的命令行工具不存在：${cli}`)
  }
  const r = spawnSync(cli, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 60_000,
    maxBuffer: 10 * 1024 * 1024
  })
  let json: unknown = null
  try {
    json = r.stdout?.trim() ? JSON.parse(r.stdout) : null
  } catch {
    /* 非 JSON 输出，保留原文 */
  }
  if (r.status !== 0) {
    const errJson = (json && typeof json === 'object' ? json : null) as { error?: string } | null
    const msg = errJson?.error || r.stderr?.trim() || `命令退出码 ${r.status}`
    throw new PublishError(`${opts.stage ?? '发布步骤'}失败：${msg}`)
  }
  return (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
}

/** 检测系统是否安装了 ssh 命令（open 写好 alias 后要用系统 ssh 免密进容器） */
function sshAvailable(): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ssh'], { encoding: 'utf8' })
  return r.status === 0
}

/**
 * 异步跑系统 ssh，对一个 host alias 执行远程命令。
 * @param alias   ssh config 里的 Host 别名（= CodeBox name）
 * @param command 远程要执行的命令；提供 stdin 则通过管道喂进去
 * @param allowNonZero 远程命令返回非零也算成功（清理/探活类命令用，避免无旧进程时误判失败）
 */
async function runSsh(
  alias: string,
  command: string,
  opts: { stdin?: string; timeout?: number; allowNonZero?: boolean } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const cp: ChildProcess = spawn(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', alias, command],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    cp.stdout?.on('data', (d) => (stdout += d.toString()))
    cp.stderr?.on('data', (d) => (stderr += d.toString()))
    const timer = setTimeout(() => {
      cp.kill('SIGKILL')
      rejectP(new PublishError(`远程命令超时：ssh ${alias} "${command.slice(0, 40)}..."`))
    }, opts.timeout ?? 30_000)
    cp.on('error', (err) => {
      clearTimeout(timer)
      rejectP(new PublishError(`无法执行 ssh 命令（系统可能未安装 OpenSSH）`, err))
    })
    cp.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && !opts.allowNonZero) {
        rejectP(new PublishError(`远程命令失败（ssh 退出码 ${code}）：${stderr.trim() || stdout.trim()}`))
      } else {
        resolveP({ stdout, stderr })
      }
    })
    if (opts.stdin !== undefined) {
      cp.stdin?.end(opts.stdin)
    } else {
      cp.stdin?.end()
    }
  })
}

/**
 * fire-and-forget 跑一条 ssh 命令：发送命令后只等固定时间就主动结束 ssh 进程，
 * 不等 close 事件。用于「起后台服务」这类命令 —— 远程用 setsid 让服务脱离会话独立存活，
 * 但 ssh 子进程可能因后台进程继承 stdio 而不触发 close（卡住），此时 ssh 卡不卡已无关紧要
 * （命令已经发出、服务已在跑），故主动 kill 释放本地进程，由调用方另行 curl 验证服务状态。
 */
async function fireAndForgetSsh(alias: string, command: string, settleMs: number): Promise<void> {
  return new Promise((resolveP) => {
    const cp: ChildProcess = spawn(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', alias, command],
      { stdio: ['pipe', 'ignore', 'ignore'] }
    )
    cp.stdin?.end()
    // 给命令足够时间发出并在远端执行；之后无论 ssh 是否退出都结束本地进程
    const timer = setTimeout(() => {
      cp.removeAllListeners()
      cp.kill('SIGKILL')
      resolveP()
    }, settleMs)
    cp.on('error', () => {
      clearTimeout(timer)
      resolveP() // 不在此处抛错：服务是否真起来由后续 curl 验证判定
    })
  })
}

/* ------------------------------ 发布主流程 ------------------------------ */

/**
 * 从项目目录名/大屏名生成 DNS-safe 的 CodeBox name 后缀。
 * 规则：小写、非字母数字转 -、去噪音后缀（plan/tdd/bash/test/demo）、合并连续 -、去首尾 -。
 * 中文名等纯非 ASCII 输入会得到空串，兜底成 codebox（避免生成 cb- / cb--dev 这类无效 name）。
 */
export function projectSlug(dir: string): string {
  let s = dir
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-(plan|tdd|bash|test|demo)$/g, '')
    .replace(/-{2,}/g, '-') // 合并连续 -（去噪音后缀可能产生 --）
    .replace(/^-+|-+$/g, '')
  return s || 'codebox'
}

/**
 * 把一个大屏版本 HTML 发布到 AiLab CodeBox，返回公网 URL。
 *
 * @param config   发布配置（endpoint / accessKey / secretKey）
 * @param codeName CodeBox 名称（已由调用方按 projectSlug 生成，如 "ai-dashboard-dev"）
 * @param html     大屏自包含 HTML（store.readPreview 的产物）
 * @returns publicUrl + detail
 */
export async function publishToAilab(
  config: PublishConfig,
  codeName: string,
  html: string
): Promise<PublishResult> {
  if (!config.endpoint || !config.accessKey || !config.secretKey) {
    throw new PublishError('发布配置不完整，请先到「设置 · 发布配置」填好 endpoint、access-key、secret-key')
  }

  /* ① init（幂等：凭据未变则跳过，避免每次发布都写文件） */
  if (
    readCfgField('endpoint') !== config.endpoint ||
    readCfgField('access_key') !== config.accessKey ||
    readCfgField('secret_key') !== config.secretKey
  ) {
    runCli(
      ['init', '--endpoint', config.endpoint, '--access-key', config.accessKey, '--secret-key', config.secretKey],
      { timeout: 30_000, stage: '初始化 AiLab 凭据' }
    )
  }

  /* ② resolve：查是否已有同名 CodeBox */
  const listed = runCli(['list', '--keyword', codeName], { timeout: 30_000, stage: '查询 CodeBox' })
  const items = (Array.isArray(listed.items) ? listed.items : Array.isArray(listed) ? listed : []) as Array<{
    name?: string
    uuid?: string
  }>
  const exists = items.some((c) => c?.name === codeName)

  /* ③ create（仅当不存在时） */
  if (!exists) {
    runCli(
      [
        'create',
        '--name',
        codeName,
        '--image-id',
        String(CODEBOX_IMAGE_ID),
        '--cpu',
        String(DEFAULT_CPU),
        '--memory',
        String(DEFAULT_MEMORY),
        '--storage',
        String(DEFAULT_STORAGE)
      ],
      { timeout: 180_000, stage: '创建 CodeBox' }
    )
  }

  /* ④ open：写 SSH managed block + 私钥，拿到 host_alias */
  const opened = runCli(['open', '--name', codeName], { timeout: 120_000, stage: '准备 CodeBox 访问' })
  const alias = (typeof opened.host_alias === 'string' && opened.host_alias) || codeName

  /* ⑤⑥⑦ 需要系统 ssh */
  if (!sshAvailable()) {
    throw new PublishError('本机没有安装 ssh 命令，无法把大屏上传到 CodeBox（请安装 OpenSSH 客户端）')
  }

  /* ⑤ 上传 HTML 到 /workspace/index.html，并清理上次发布的静态服务进程。
   *    清理旧进程的坑：pkill/pgrep -f 按「整条命令行字符串」匹配，而 ssh 会把多条命令拼进
   *    一个 `bash -c '整条命令'`，命令行里就含 "http.server" 字样 → pkill 把执行它的 bash -c
   *    会话也杀了（ssh 退出 255）。所以用字符串拼接 "http.ser""ver" 绕过自身匹配，
   *    再 kill 找到的 pid；清理步骤允许失败（首次发布没有旧进程很正常）。 */
  await runSsh(
    alias,
    'mkdir -p /workspace && PIDS=$(pgrep -f "http.ser""ver"); [ -n "$PIDS" ] && kill $PIDS 2>/dev/null; true',
    { timeout: 20_000, allowNonZero: true }
  )
  await runSsh(alias, 'cat > /workspace/index.html', { stdin: html, timeout: 20_000 })

  /* ⑥ 在 9229 起静态服务（python3 -m http.server，必须绑 0.0.0.0 才能被公网访问）。
   *    后台进程的坑：远程起后台服务时，ssh 子进程可能因后台进程继承 stdio 而不触发 close（卡住）。
   *    故用 setsid 让服务脱离会话独立存活 + fireAndForgetSsh 发命令后不等 close（命令已发出即可），
   *    服务是否真起来由下一步单独 ssh curl 验证。 */
  await fireAndForgetSsh(
    alias,
    `cd /workspace && setsid python3 -m http.server ${SERVE_PORT} --bind 0.0.0.0 </dev/null >/tmp/serve.log 2>&1 & exit 0`,
    3000
  )
  // 等服务就绪，单独 ssh 进去 curl 验证（普通命令，runSsh 会正常 close）
  await new Promise((r) => setTimeout(r, 2000))
  const probe = await runSsh(
    alias,
    `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${SERVE_PORT}/`,
    { timeout: 15_000 }
  )
  if (!probe.stdout.includes('200')) {
    // 起服务可能失败：读容器内 serve.log 帮助定位
    const log = await runSsh(alias, 'tail -5 /tmp/serve.log 2>/dev/null', { timeout: 10_000, allowNonZero: true })
    throw new PublishError(`大屏服务没起来（容器内 9229 返回 ${probe.stdout.trim() || '空'}）：${log.stdout.trim() || '无日志'}`)
  }

  /* ⑦ publish：把容器内 9229 暴露到公网 */
  const pub = runCli(['publish', '--name', codeName, '--container-port', String(SERVE_PORT)], {
    timeout: 60_000,
    stage: '发布到公网'
  })
  const publicUrl = typeof pub.public_url === 'string' ? pub.public_url : ''
  if (!publicUrl) {
    throw new PublishError('发布完成，但 AiLab 没有返回公网地址')
  }

  return {
    publicUrl,
    detail: {
      publicHost: typeof pub.public_host === 'string' ? pub.public_host : undefined,
      publicAddress: typeof pub.public_address === 'string' ? pub.public_address : undefined,
      hostPort: typeof pub.host_port === 'number' ? pub.host_port : undefined,
      containerPort: typeof pub.container_port === 'number' ? pub.container_port : undefined
    }
  }
}
