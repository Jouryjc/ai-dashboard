/**
 * Prompt 加载器 —— 系统所有 LLM prompt 的唯一入口。
 *
 * 所有 prompt 以 Markdown 文件形式存放在 server/prompts/（可用 PROMPTS_DIR 环境变量覆盖），
 * 脱离代码独立维护、直接编辑即生效（每次调用现读，不缓存——改完 prompt 不用重启）。
 *
 * 文件约定：
 * - `{{变量名}}` 占位符，由调用方传入 vars 替换；未提供的变量替换为空串
 * - 末尾空白自动 trim
 */
import fs from 'node:fs'
import path from 'node:path'

const PROMPTS_DIR = process.env.PROMPTS_DIR
  ? path.resolve(process.env.PROMPTS_DIR)
  : path.resolve(process.cwd(), 'prompts')

/** 读取并渲染一个 prompt 文件（server/prompts/<name>.md） */
export function prompt(name: string, vars: Record<string, string> = {}): string {
  const file = path.join(PROMPTS_DIR, `${name}.md`)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(`prompt 文件缺失：${file}（可用 PROMPTS_DIR 环境变量指定 prompt 目录）`)
  }
  return text
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '')
    .trimEnd()
}
