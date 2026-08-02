/**
 * 本地开发脚本：先起 Vite 开发服务器，端口就绪后拉起 Electron。
 * 用法：npm run electron:dev
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import path from 'node:path'

const PORT = 5173
const DEV_URL = `http://localhost:${PORT}`

const vite = spawn('npx', ['vite'], { stdio: 'inherit', shell: true })

function waitForPort(port, retries = 120) {
  return new Promise((resolve, reject) => {
    const tryOnce = (left) => {
      // 用 'localhost' 而不是 '127.0.0.1'：Vite 6 在这台机器上只绑 IPv6 的 ::1，
      // 直连 127.0.0.1 会被拒绝，明明起来了也误判超时
      const sock = net.connect(port, 'localhost')
      sock.once('connect', () => { sock.end(); resolve(true) })
      sock.once('error', () => {
        if (left <= 0) return reject(new Error('等待 Vite 开发服务器超时'))
        setTimeout(() => tryOnce(left - 1), 500)
      })
    }
    tryOnce(retries)
  })
}

try {
  await waitForPort(PORT)
  // Windows 下 .bin/electron.cmd 经 spawn 直接拉起会触发 EINVAL（Node 20+ 对 .cmd 的安全限制），
  // 直接指向 electron 包内置的真实可执行文件最稳；其他平台沿用 .bin/electron。
  const here = fileURLToPath(new URL('.', import.meta.url))
  const bin =
    process.platform === 'win32'
      ? path.join(here, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(here, '..', 'node_modules', '.bin', 'electron')
  const child = spawn(bin, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL }
  })
  child.on('close', () => { vite.kill(); process.exit(0) })
} catch (err) {
  console.error(err)
  vite.kill()
  process.exit(1)
}
