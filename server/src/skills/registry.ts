import fs from 'node:fs'
import path from 'node:path'
import type { ArtifactKind } from '../wire'

interface SkillConfigFile {
  schemaVersion: 1
  id: string
  artifactKinds: ArtifactKind[]
  executionAdapter: string | null
  allowedCommands: string[]
  permissions: {
    filesystem: 'project-read' | 'skill-read'
    network: 'deny' | 'allow'
    process: 'deny' | 'allowlisted'
  }
}

export interface RegisteredSkill {
  id: string
  name: string
  description: string
  directory: string
  instructionsFile: string
  config: SkillConfigFile
}

const SKILLS_DIR = process.env.SKILLS_DIR
  ? path.resolve(process.env.SKILLS_DIR)
  : path.resolve(process.cwd(), 'skills')

function parseFrontmatter(text: string, file: string): { name: string; description: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new Error(`skill 缺少 YAML frontmatter：${file}`)
  const values = new Map<string, string>()
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([a-zA-Z][\w-]*):\s*(.+)$/.exec(line)
    if (field) values.set(field[1], field[2].trim().replace(/^["']|["']$/g, ''))
  }
  const name = values.get('name') ?? ''
  const description = values.get('description') ?? ''
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error(`skill name 不合法：${file}`)
  if (!description) throw new Error(`skill description 不能为空：${file}`)
  return { name, description }
}

function readConfig(file: string): SkillConfigFile {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SkillConfigFile>
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.id !== 'string' ||
    !Array.isArray(raw.artifactKinds) ||
    !Array.isArray(raw.allowedCommands) ||
    !raw.permissions
  ) {
    throw new Error(`skill.config.json 格式不正确：${file}`)
  }
  for (const kind of raw.artifactKinds) {
    if (kind !== 'dashboard' && kind !== 'business-app') {
      throw new Error(`skill 声明了未知产物类型：${kind}`)
    }
  }
  if (
    (raw.permissions.filesystem !== 'project-read' && raw.permissions.filesystem !== 'skill-read') ||
    (raw.permissions.network !== 'deny' && raw.permissions.network !== 'allow') ||
    (raw.permissions.process !== 'deny' && raw.permissions.process !== 'allowlisted') ||
    raw.allowedCommands.some(command => typeof command !== 'string' || !/^[a-z][a-z0-9-]*$/.test(command)) ||
    new Set(raw.allowedCommands).size !== raw.allowedCommands.length ||
    (raw.executionAdapter !== null && typeof raw.executionAdapter !== 'string')
  ) {
    throw new Error(`skill.config.json 权限或命令声明不合法：${file}`)
  }
  return raw as SkillConfigFile
}

export class SkillRegistry {
  private readonly skills = new Map<string, RegisteredSkill>()

  load(): void {
    this.skills.clear()
    if (!fs.existsSync(SKILLS_DIR)) return
    for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-z0-9-]+$/.test(entry.name)) continue
      const directory = path.join(SKILLS_DIR, entry.name)
      const instructionsFile = path.join(directory, 'SKILL.md')
      const configFile = path.join(directory, 'skill.config.json')
      if (!fs.existsSync(instructionsFile) || !fs.existsSync(configFile)) continue
      const instructions = fs.readFileSync(instructionsFile, 'utf8')
      if (Buffer.byteLength(instructions, 'utf8') > 128 * 1024) {
        throw new Error(`skill 指令过大：${instructionsFile}`)
      }
      const metadata = parseFrontmatter(instructions, instructionsFile)
      const config = readConfig(configFile)
      if (metadata.name !== entry.name || config.id !== entry.name) {
        throw new Error(`skill 目录名、name 与 config.id 必须一致：${directory}`)
      }
      if (this.skills.has(config.id)) throw new Error(`skill 重复注册：${config.id}`)
      this.skills.set(config.id, {
        id: config.id,
        name: metadata.name,
        description: metadata.description,
        directory,
        instructionsFile,
        config
      })
    }
  }

  get(id: string): RegisteredSkill {
    const skill = this.skills.get(id)
    if (!skill) throw new Error(`skill 未注册：${id}`)
    return skill
  }

  forArtifact(kind: ArtifactKind): RegisteredSkill[] {
    return [...this.skills.values()].filter((skill) => skill.config.artifactKinds.includes(kind))
  }

  list(): RegisteredSkill[] {
    return [...this.skills.values()]
  }
}

export const skillRegistry = new SkillRegistry()
