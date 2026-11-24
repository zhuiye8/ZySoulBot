// 隔离工作区工具 + 自造 Skill 自检登记 + 原生凭证工具（全属 create 层，受路径沙箱与灾难命令硬护栏保护）。
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { RegisteredTool, SoulStore, ToolRunContext } from '../shared/ports.ts'
import { nowLocal } from '../shared/time.ts'
import { CredFieldSchema } from '../soul/governance/credentials.ts'
import type { CredentialStore } from '../soul/governance/credentials.ts'
import type { InMemoryToolRegistry } from './registry.ts'

const execFileAsync = promisify(execFile)

// 灾难命令硬护栏（代码层不可绕过）
const DISASTER_COMMANDS: RegExp[] = [
  /rm\s+(-[a-z]+\s+)*-?[rf]+\s+(\/|~|\$HOME|\*)/i,
  /mkfs(\.\w+)?\s/i,
  /dd\s+[^;]*of=\/dev\/(sd|nvme|vd|hd)/i,
  /\b(shutdown|reboot|halt|poweroff|sudo|su\s+-)\b/i,
  /chmod\s+777\s+\//i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
  /curl\s+[^|]+\|\s*(ba)?sh/i,
  /format\s+[a-z]:/i,
  /Remove-Item\s+.*-Recurse\s+.*[A-Za-z]:\\(\s|$)/i,
]

export function isDangerousCommand(cmd: string): boolean {
  return DISASTER_COMMANDS.some((re) => re.test(cmd))
}

// 严格路径沙箱：只允许访问 workspaceRoot 内部路径
export function safeResolveInWorkspace(workspaceRoot: string, relPath: string): string | null {
  const root = resolve(workspaceRoot)
  const target = resolve(root, relPath)
  const rel = relative(root, target)
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(rel) === rel && rel !== '') {
    return null
  }
  return target
}

const ListArgsSchema = z.object({
  dir: z.string().default('.'),
})

const ReadArgsSchema = z.object({
  path: z.string().min(1).max(200),
})

const WriteArgsSchema = z.object({
  path: z.string().min(1).max(200),
  content: z.string().max(60_000),
})

const RunArgsSchema = z.object({
  command: z.string().min(1).max(1000),
  timeoutSec: z.number().int().min(1).max(60).default(30),
})

const RegisterSkillArgsSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,35}$/),
  summary: z.string().min(2).max(120),
  verifyCommand: z.string().max(400).optional(),
})

const RequestCredArgsSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,35}$/),
  label: z.string().min(1).max(60),
  provider: z.string().min(1).max(60),
  providerName: z.string().max(60).optional(),
  why: z.string().max(200).optional(),
  howto: z.string().max(400).optional(),
  fields: z.array(CredFieldSchema).min(1).max(12),
})

const ReadCredArgsSchema = z.object({
  name: z.string().min(1).max(40),
})

async function runShellCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const isWin = process.platform === 'win32'
  const bin = isWin ? 'powershell.exe' : '/bin/sh'
  const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command]
  try {
    const res = await execFileAsync(bin, args, { cwd, env, timeout: timeoutMs, maxBuffer: 512 * 1024 })
    return { stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? ''), exitCode: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string }
    return {
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
      exitCode: typeof err.code === 'number' ? err.code : 1,
    }
  }
}

export function registerWorkspaceTools(
  registry: InMemoryToolRegistry,
  deps: {
    workspaceDir: string
    store: SoulStore
    credentials: CredentialStore
    /** P0-3 执行层门控（Mask, Don't Remove）：冻结 tools 数组保 Prefix Cache，在执行时拦截非授权调用 */
    allowCreate?: (ctx: ToolRunContext) => boolean
    onCredentialRequested?: (credName: string) => void
  },
): void {
  const root = resolve(deps.workspaceDir)
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'skills'), { recursive: true })

  const registerGuarded = (tool: RegisteredTool): void => {
    registry.register({
      ...tool,
      async execute(args, ctx) {
        if (deps.allowCreate && !deps.allowCreate(ctx)) {
          return { output: '这个工作区工具仅在独处或管理员私聊里可用。', isError: true }
        }
        return tool.execute(args, ctx)
      },
    })
  }

  registerGuarded({
    layer: 'create',
    spec: {
      name: 'workspace_list',
      description: '列出自己工作区目录里的文件与子目录。',
      parameters: {
        type: 'object',
        properties: { dir: { type: 'string', description: '相对路径，默认 .' } },
      },
    },
    async execute(args) {
      const { dir } = ListArgsSchema.parse(args)
      const target = safeResolveInWorkspace(root, dir)
      if (!target) return { output: '不能访问工作区以外的目录。', isError: true }
      if (!existsSync(target)) return { output: `目录不存在：${dir}` }
      const entries = readdirSync(target).slice(0, 80).map((name) => {
        const full = join(target, name)
        const isDir = statSync(full).isDirectory()
        return isDir ? `${name}/` : name
      })
      return {
        output: entries.length ? entries.join('\n') : '（空目录）',
        foldSummary: `查看工作区 ${dir}（${entries.length} 项）`,
      }
    },
  })

  registerGuarded({
    layer: 'create',
    spec: {
      name: 'workspace_read',
      description: '读取自己工作区里的文本文件（代码、SKILL.md、笔记等）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '工作区内的相对路径' } },
        required: ['path'],
      },
    },
    async execute(args) {
      const { path } = ReadArgsSchema.parse(args)
      const target = safeResolveInWorkspace(root, path)
      if (!target) return { output: '不能读取工作区以外的文件。', isError: true }
      if (!existsSync(target)) return { output: `文件不存在：${path}`, isError: true }
      const content = readFileSync(target, 'utf8')
      return {
        output: content.slice(0, 2400),
        foldSummary: `读取文件 ${path}`,
      }
    },
  })

  registerGuarded({
    layer: 'create',
    spec: {
      name: 'workspace_write',
      description: '在自己工作区里创建或覆盖文件（如写脚本、写 skills/<name>/SKILL.md）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区内的相对路径' },
          content: { type: 'string', description: '文件完整内容' },
        },
        required: ['path', 'content'],
      },
    },
    async execute(args) {
      const { path, content } = WriteArgsSchema.parse(args)
      const target = safeResolveInWorkspace(root, path)
      if (!target) return { output: '不能写入工作区以外的路径。', isError: true }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      return {
        output: `已写入 ${path}（${content.length} 字符）。`,
        foldSummary: `写入文件 ${path}`,
      }
    },
  })

  registerGuarded({
    layer: 'create',
    spec: {
      name: 'workspace_run',
      description: '在自己工作区里运行脚本或命令（支持 Python/Node，环境变量 ZYSOUL_CREDENTIALS 指向凭证文件）。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          timeoutSec: { type: 'number', description: '超时秒数（1-60，默认 30）' },
        },
        required: ['command'],
      },
    },
    async execute(args) {
      const { command, timeoutSec } = RunArgsSchema.parse(args)
      if (isDangerousCommand(command)) {
        return { output: '该命令命中系统安全护栏，已被拒绝执行。', isError: true }
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ZYSOUL_CREDENTIALS: resolve(deps.credentials.path),
      }
      const res = await runShellCommand(command, root, env, timeoutSec * 1000)
      const combined = [
        res.stdout ? `STDOUT:\n${res.stdout.trim()}` : '',
        res.stderr ? `STDERR:\n${res.stderr.trim()}` : '',
      ].filter(Boolean).join('\n')
      return {
        output: `exit=${res.exitCode}\n${combined || '（无输出）'}`.slice(0, 2400),
        foldSummary: `运行命令（exit=${res.exitCode}）：${command.slice(0, 40)}`,
        isError: res.exitCode !== 0,
      }
    },
  })

  registerGuarded({
    layer: 'create',
    spec: {
      name: 'register_skill',
      description: '把工作区 skills/<name>/ 里做好的新技能自检并登记进能力台账（必须先写好 SKILL.md）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名（小写字母、数字、短横线）' },
          summary: { type: 'string', description: '一句话说明这项本领能做什么' },
          verifyCommand: { type: 'string', description: '可选自检命令（返回码 0 才算通过）' },
        },
        required: ['name', 'summary'],
      },
    },
    async execute(args, ctx) {
      const { name, summary, verifyCommand } = RegisterSkillArgsSchema.parse(args)
      const skillDir = safeResolveInWorkspace(root, join('skills', name))
      if (!skillDir || !existsSync(join(skillDir, 'SKILL.md'))) {
        return { output: `登记失败：找不到 skills/${name}/SKILL.md，请先写好技能说明文件。`, isError: true }
      }
      if (verifyCommand) {
        if (isDangerousCommand(verifyCommand)) {
          return { output: '自检命令命中安全护栏，已被拒绝。', isError: true }
        }
        const env: NodeJS.ProcessEnv = { ...process.env, ZYSOUL_CREDENTIALS: resolve(deps.credentials.path) }
        const check = await runShellCommand(verifyCommand, skillDir, env, 20_000)
        if (check.exitCode !== 0) {
          return {
            output: `技能自检未通过（exit=${check.exitCode}）：${(check.stderr || check.stdout).slice(0, 400)}`,
            isError: true,
          }
        }
      }
      deps.store.upsertCapability({
        name,
        kind: 'skill',
        summary,
        skillDir,
        status: 'active',
        createdAt: nowLocal(ctx.now),
      })
      return {
        output: `技能「${name}」已自检通过并登记进能力台账，之后可以随时使用。`,
        foldSummary: `学会新技能：${name}`,
      }
    },
  })

  registerGuarded({
    layer: 'create',
    spec: {
      name: 'request_credential',
      description: '当需要外部服务（如生图、地图、音乐）的 API 密钥时，登记需要的字段与申请说明，管理员会在后台安全填写（密钥绝不经过聊天）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '稳定标识，如 image-gen' },
          label: { type: 'string', description: '人话名称，如 生图服务' },
          provider: { type: 'string', description: '供应商代号，如 aliyun-wanx' },
          providerName: { type: 'string', description: '供应商中文名，如 阿里云通义万相' },
          why: { type: 'string', description: '你为什么需要它' },
          howto: { type: 'string', description: '去哪里申请、需要复制什么' },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                label: { type: 'string' },
                type: { type: 'string', enum: ['text', 'secret'] },
                required: { type: 'boolean' },
              },
              required: ['key', 'label'],
            },
          },
        },
        required: ['name', 'label', 'provider', 'fields'],
      },
    },
    async execute(args, ctx) {
      const parsed = RequestCredArgsSchema.parse(args)
      const { need } = deps.credentials.registerNeed({ ...parsed, now: ctx.now })
      deps.onCredentialRequested?.(need.name)
      return {
        output: `已登记凭证需求「${need.label}」（标识 ${need.name}）。管理员在后台填好后，你就可以用 read_credential 或脚本取用了。`,
        foldSummary: `登记凭证需求：${need.label}`,
      }
    },
  })

  registerGuarded({
    layer: 'create',
    spec: {
      name: 'read_credential',
      description: '检查某项外部服务凭证是否已填好（返回是否就绪及字段名，不在上下文暴露敏感密文；脚本通过 ZYSOUL_CREDENTIALS 文件读取实际值）。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '凭证标识，如 image-gen' } },
        required: ['name'],
      },
    },
    async execute(args) {
      const { name } = ReadCredArgsSchema.parse(args)
      const vals = deps.credentials.getValues(name)
      if (!vals) {
        return { output: `凭证「${name}」尚未填写。`, foldSummary: `查凭证 ${name}：未填` }
      }
      return {
        output: `凭证「${name}」已就绪，已填字段：${Object.keys(vals).join(', ')}。请在工作区脚本里从环境变量 ZYSOUL_CREDENTIALS 指向的 JSON 文件读取 values。`,
        foldSummary: `查凭证 ${name}：已就绪`,
      }
    },
  })
}
