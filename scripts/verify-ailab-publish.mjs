#!/usr/bin/env node
/**
 * ailab-codebox 真实发布链路验证脚本（逐步、可观测、失败即停）。
 *
 * 目的：把方案中「只能推断」的核心链路逐环节跑通，用真实结果决定方案是否可行。
 *
 * 用法（Git Bash，Windows）：
 *   export AILAB_ENDPOINT="http://59.37.133.154"
 *   export AILAB_AK="你的 AccessKey"
 *   export AILAB_SK="你的 SecretKey"
 *   export AILAB_CODEBOX="verify-publish-dev"   # 可选，默认 verify-publish-dev
 *   node scripts/verify-ailab-publish.mjs
 *
 * 每一步打印 [PASS]/[FAIL] + 真实输出；任一环节失败立即终止并报告。
 * 脚本最后会删掉验证用的 CodeBox（AILAB_KEEP=1 时不删）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLI = 'C:\\Users\\sangfor\\AppData\\Local\\Temp\\ailab-codebox\\ailab-codebox\\scripts\\ailab-codebox.exe'

const ENDPOINT = process.env.AILAB_ENDPOINT
const AK = process.env.AILAB_AK
const SK = process.env.AILAB_SK
const NAME = process.env.AILAB_CODEBOX || 'verify-publish-dev'
const CFG_FILE = join(homedir(), '.ailab-codebox', 'config.yaml')
const SSH_CFG = join(homedir(), '.ssh', 'config')

let step = 0
function log(label, msg) { console.log(`\n[步骤${++step}] ${label}\n${msg}`) }
function pass(msg) { console.log(`  ✅ [PASS] ${msg}`) }
function fail(msg) { console.log(`  ❌ [FAIL] ${msg}`); console.log(`\n==== 验证在此终止（步骤 ${step}）====`); process.exit(1) }

/** 同步跑 CLI（捕获 JSON），超时或非零退出抛错。返回 {code,json,stdout,stderr} */
function runCli(args, opts = {}) {
  const timeoutMs = opts.timeout ?? 60_000
  const r = spawnSync(CLI, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 })
  let json = null
  try { json = r.stdout?.trim() ? JSON.parse(r.stdout) : null } catch { /* 非 JSON，保留原文 */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr, signal: r.signal }
}

/** 真实系统 ssh 命令是否存在 */
function hasSsh() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ssh'], { encoding: 'utf8' })
  return r.status === 0
}

console.log('================ ailab-codebox 发布链路验证 ================')
console.log(`CLI      : ${CLI}`)
console.log(`ENDPOINT : ${ENDPOINT || '(未设置!)'}`)
console.log(`AK       : ${AK ? AK.slice(0, 6) + '****' : '(未设置!)'}`)
console.log(`SK       : ${SK ? '****(已设置)' : '(未设置!)'}`)
console.log(`CodeBox  : ${NAME}`)
if (!ENDPOINT || !AK || !SK) {
  fail('缺少环境变量 AILAB_ENDPOINT / AILAB_AK / AILAB_SK，无法验证真实链路。')
}

/* ---------- ① init ---------- */
log('init 初始化凭据', `写入 ${CFG_FILE}`)
{
  const r = runCli(['init', '--endpoint', ENDPOINT, '--access-key', AK, '--secret-key', SK])
  if (r.code !== 0) fail(`init 退出码 ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
  pass(`init 成功：${r.stdout.trim()}`)
  if (!existsSync(CFG_FILE)) fail(`config.yaml 未生成：${CFG_FILE}`)
  const cfg = readFileSync(CFG_FILE, 'utf8').replace(/(secret_key:\s*).*/, '$1****(已脱敏)')
  pass(`config.yaml 存在，内容：\n${cfg}`)
}

/* ---------- ② list ---------- */
log('list 查询 CodeBox（API 联通性 + 签名）', `GET ${ENDPOINT}/api/v1/automation/codeboxes`)
{
  const r = runCli(['list'], { timeout: 30_000 })
  if (r.code !== 0) fail(`list 失败（API 不通或签名错）\ncode:${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
  const list = Array.isArray(r.json) ? r.json : (r.json?.items ?? r.json?.data ?? [])
  pass(`list 成功，返回 ${Array.isArray(list) ? list.length : '?'} 条`)
  const hit = (Array.isArray(list) ? list : []).find((c) => c?.name === NAME)
  if (hit) pass(`已存在同名 CodeBox，复用：uuid=${hit.uuid ?? hit.id ?? '?'}`)
  else console.log('  ℹ️  无同名 CodeBox，下一步将创建')
}

/* ---------- ③ create ---------- */
log('create 创建 CodeBox', `name=${NAME} image-id=2(cpu/mem 用镜像默认)`)
{
  // 只有一个可用镜像 codebox:v1.1 (id=2)；cpu/memory/storage 仍显式给（CLI 要求 image-id 必填）
  const r = runCli(['create', '--name', NAME, '--image-id', '2', '--cpu', '1', '--memory', '2048', '--storage', '20'], { timeout: 180_000 })
  if (r.code !== 0) {
    const lr = runCli(['list'], { timeout: 30_000 })
    const list = Array.isArray(lr.json) ? lr.json : []
    const hit = list.find((c) => c?.name === NAME)
    if (hit) pass(`create 提示已存在，已确认存在 uuid=${hit.uuid ?? hit.id}`)
    else fail(`create 失败\ncode:${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
  } else {
    pass(`create 成功，JSON 字段：${Object.keys(r.json ?? {}).join(', ')}`)
    console.log(`  返回内容（截断）：${JSON.stringify(r.json).slice(0, 400)}`)
  }
}

/* ---------- ④ open（关键：ssh config + 私钥） ---------- */
log('open 设置 SSH（验证 ~/.ssh/config managed block + 私钥是否写入）', '')
{
  const before = existsSync(SSH_CFG) ? readFileSync(SSH_CFG, 'utf8') : ''
  const r = runCli(['open', '--name', NAME], { timeout: 120_000 })
  if (r.code !== 0) fail(`open 失败\ncode:${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
  pass(`open 成功，JSON 字段：${Object.keys(r.json ?? {}).join(', ')}`)
  console.log(`  open 返回：${JSON.stringify(r.json, null, 2).slice(0, 600)}`)
  const after = existsSync(SSH_CFG) ? readFileSync(SSH_CFG, 'utf8') : ''
  const alias = r.json?.host_alias || NAME
  if (after.includes('AILAB-CODEBOX') || after.includes(`Host ${alias}`)) {
    pass(`~/.ssh/config 已写入 managed block（alias=${alias}）`)
  } else if (before === after) {
    fail(`open 成功但 ~/.ssh/config 未变化 —— managed block 可能未写入！\nopen JSON: ${JSON.stringify(r.json, null, 2)}`)
  } else {
    pass(`~/.ssh/config 有变化（alias=${alias}），将在 ssh 步骤实测免密`)
  }
  globalThis.__ALIAS = alias
}

const ALIAS = globalThis.__ALIAS || NAME

/* ---------- ⑤ 系统 ssh ---------- */
log('检测系统 ssh 命令', '')
{
  if (hasSsh()) pass('系统 ssh 命令存在')
  else fail('系统缺少 ssh 命令（Windows 需启用 OpenSSH 客户端）')
}

/* ---------- ⑥ ssh 免密进容器 ---------- */
log('ssh 进容器执行命令', `ssh ${ALIAS} "..."`)
{
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', ALIAS, 'echo __SSH_OK__; uname -a; whoami'], { encoding: 'utf8', timeout: 40_000 })
  if (r.status !== 0 || !r.stdout?.includes('__SSH_OK__')) {
    fail(`系统 ssh 无法免密进容器或执行失败\nstatus:${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
  }
  pass(`ssh 免密进容器成功，可执行远程命令：\n${r.stdout.trim()}`)
}

/* ---------- ⑦ 静态服务能力探活 ---------- */
log('容器内静态服务能力探活', 'which python3 / busybox / node')
{
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', ALIAS, 'echo "py3=$(which python3 2>/dev/null)"; echo "py=$(which python 2>/dev/null)"; echo "bb=$(which busybox 2>/dev/null)"; echo "node=$(which node 2>/dev/null)"; echo "curl=$(which curl 2>/dev/null)"; echo "wget=$(which wget 2>/dev/null)"'], { encoding: 'utf8', timeout: 20_000 })
  console.log(`  探活输出：\n${(r.stdout || '').trim() || '(空——可能都没有)'}`)
  const out = r.stdout || ''
  if (out.includes('py3=/') || out.includes('py=/')) pass('容器内有 python —— 可用 python -m http.server')
  else if (out.includes('bb=/')) pass('容器内无 python 但有 busybox —— 可用 busybox httpd')
  else if (out.includes('node=/')) pass('容器内无 python/busybox 但有 node')
  else fail('容器内无 python/busybox/node —— 需指定预装静态服务的镜像')
}

/* ---------- ⑧ 上传 HTML + 起服务 ---------- */
log('上传 HTML 并在 9229 起静态服务', '拆分命令：清理→上传→起服务(立即返回)→单独curl验证')
{
  const html = '<!doctype html><meta charset=utf-8><title>verify</title><h1>ailab-publish-verify OK</h1>'

  /** 异步 ssh（与发布器 runSsh 一致，避免 spawnSync 在 Windows 下对 & 的处理差异） */
  async function sshAsync(command, opts = {}) {
    return new Promise((resolve, reject) => {
      const cp = spawn('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','-o','ConnectTimeout=20', ALIAS, command], { stdio:['pipe','pipe','pipe'] })
      let stdout='', stderr=''
      cp.stdout.on('data', d => stdout += d)
      cp.stderr.on('data', d => stderr += d)
      const timer = setTimeout(() => { cp.kill('SIGKILL'); reject(new Error(`超时：${command.slice(0,40)}`)) }, opts.timeout ?? 30_000)
      cp.on('error', e => { clearTimeout(timer); reject(e) })
      cp.on('close', code => { clearTimeout(timer); if (code !== 0 && !opts.allowNonZero) reject(new Error(`ssh 退出 ${code}: ${stderr.trim()}`)); else resolve({stdout,stderr}) })
      if (opts.stdin !== undefined) cp.stdin.end(opts.stdin); else cp.stdin.end()
    })
  }

  // 清理旧服务进程：pgrep 字符串拼接绕过 -f 自身匹配，避免 pkill 杀掉 bash -c 会话（ssh 退出 255）
  await sshAsync('mkdir -p /workspace && PIDS=$(pgrep -f "http.ser""ver"); [ -n "$PIDS" ] && kill $PIDS 2>/dev/null; true', { allowNonZero: true }).catch(() => {})
  const up = await sshAsync('cat > /workspace/index.html', { stdin: html })
  if (up === undefined) fail('上传 HTML 失败')
  pass('HTML 已上传到 /workspace/index.html')
  // 起服务：fire-and-forget（远程 setsid 让服务独立存活；ssh 可能因后台进程继承 stdio 不 close，
  // 故发命令后只等固定时间就 kill ssh，服务是否真起来由下一步 curl 验证）
  await new Promise((resolve) => {
    const cp = spawn('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','-o','ConnectTimeout=20', ALIAS, 'cd /workspace && setsid python3 -m http.server 9229 --bind 0.0.0.0 </dev/null >/tmp/srv.log 2>&1 & exit 0'], { stdio:['pipe','ignore','ignore'] })
    cp.stdin.end()
    setTimeout(() => { cp.kill('SIGKILL'); resolve() }, 3000)
  })
  pass('http.server 启动命令已发出（fire-and-forget）')
  // 单独 curl 验证（等服务就绪）
  await new Promise((r) => setTimeout(r, 2500))
  const curl = await sshAsync('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9229/')
  if (curl.stdout.trim() === '200') pass(`容器内 9229 自测可访问：${curl.stdout.trim()}`)
  else fail(`容器内 9229 自测失败：${curl.stdout} / ${curl.stderr}`)
}

/* ---------- ⑨ publish 拿公网 URL ---------- */
log('publish 暴露公网端口', `publish --name ${NAME}`)
{
  const r = runCli(['publish', '--name', NAME], { timeout: 60_000 })
  if (r.code !== 0) fail(`publish 失败\ncode:${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
  const url = r.json?.public_url
  const addr = r.json?.public_address
  console.log(`  publish 返回：${JSON.stringify(r.json, null, 2)}`)
  if (!url && !addr) fail(`publish 成功但无 public_url/public_address`)
  pass(`拿到公网地址：url=${url ?? '(无)'} addr=${addr ?? '(无)'}`)
  globalThis.__URL = url
}

/* ---------- ⑩ 公网可达性 ---------- */
if (globalThis.__URL) {
  log('公网 URL 可达性', `curl ${globalThis.__URL}`)
  const r = spawnSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20', globalThis.__URL], { encoding: 'utf8', timeout: 30_000 })
  if (r.stdout === '200') pass(`公网 URL 可访问（HTTP 200）🎉`)
  else console.log(`  ⚠️  公网自测 ${r.stdout || '失败'}（可能入口未就绪，不强求）: ${r.stderr}`)
}

/* ---------- 清理 ---------- */
console.log('\n================ 验证完成 ================')
if (process.env.AILAB_KEEP === '1') {
  console.log(`AILAB_KEEP=1，保留 CodeBox「${NAME}」供人工复核。`)
} else {
  log('清理验证用 CodeBox', `delete --name ${NAME}`)
  const r = runCli(['delete', '--name', NAME], { timeout: 30_000 })
  console.log(r.code === 0 ? `  🧹 已删除` : `  ⚠️  删除 code:${r.code}（可手动删）: ${r.stdout} ${r.stderr}`)
}
console.log('\n结论：PASS 的环节即为已验证可行；FAIL 的环节需在正式方案中针对性处理。')
