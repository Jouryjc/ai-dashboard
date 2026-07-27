/**
 * 本地开发脚本：先起 Vite 开发服务器，端口就绪后拉起 Electron。
 * 用法：npm run electron:dev
 */
import { spawn } from 'node:child_process'
import net from 'node:net'

const PORT = 5173
const DEV_URL = `http://localhost:${PORT}`

const vite = spawn('npx', ['vite'], { stdio: 'inherit', shell: true })

function waitForPort(port, retries = 120) {
  return new Promise((resolve, reject) => {
    const tryOnce = (left) => {
      const sock = net.connect(port, '127.0.0.1')
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
  const electronBin = process.platform === 'win32' ? 'electron.cmd' : 'electron'
  const bin = new URL(`../node_modules/.bin/${electronBin}`, import.meta.url).pathname
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
