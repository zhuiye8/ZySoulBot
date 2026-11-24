// 隔离工作区工具 + 自造 Skill 自检登记 + 原生凭证工具（全属 create 层，受路径/符号链接沙箱、默认禁执行门控与灾难命令硬护栏保护）。
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { RegisteredTool, SoulStore, ToolRunContext } from '../shared/ports.ts'
import { nowLocal } from '../shared/time.ts'
import { CredFieldSchema } from '../soul/governance/credentials.ts'
import type { CredentialStore } from '../soul/governance/credentials.ts'
import type { InMemoryToolRegistry } from './registry.ts'

const MAX_READ_BYTES = 256 * 1024
const SAFE_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'NODE_ENV',
])

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

function isWithinRoot(realRoot: string, candidate: string): boolean {
  const rel = relative(realRoot, candidate)
  if (!rel) return true
  return !rel.startsWith('..') && !rel.includes(`..${sep}`) && !(resolve(rel) === rel)
}

// 严格路径 + 符号链接沙箱（P1-SEC-03）：
// 1. 禁止空字节与越界相对路径
// 2. 逐级检查已有路径分量，任一分量为符号链接即拒绝
// 3. 对最深已有祖先做 realpathSync 二次边界核验
export function safeResolveInWorkspace(workspaceRoot: string, relPath: string): string | null {
  if (!relPath || relPath.includes('\0')) return null
  const absRoot = resolve(workspaceRoot)
  const realRoot = existsSync(absRoot) ? realpathSync(absRoot) : absRoot
  const target = resolve(realRoot, relPath)
  if (!isWithinRoot(realRoot, target)) return null

  const rel = relative(realRoot, target)
  const parts = rel ? rel.split(sep).filter(Boolean) : []
  let cur = realRoot
  let deepestExisting = realRoot
  for (const part of parts) {
    cur = join(cur, part)
    if (!existsSync(cur)) {
      // 检查是否悬空符号链接（existsSync 对悬空 symlink 返回 false，但 lstatSync 存在）
      try {
        if (lstatSync(cur).isSymbolicLink()) return null
      } catch {
        // 确实不存在
      }
      break
    }
    try {
      if (lstatSync(cur).isSymbolicLink()) return null
    } catch {
      return null
    }
    deepestExisting = cur
  }
  if (existsSync(deepestExisting)) {
    try {
      const realDeepest = realpathSync(deepestExisting)
      if (!isWithinRoot(realRoot, realDeepest)) return null
    } catch {
      return null
    }
  }
  return target
}

function readUtf8Bounded(filePath: string, maxBytes: number): { ok: true; text: string; truncated: boolean } | { ok: false; error: string } {
  const st = lstatSync(filePath)
  if (st.isSymbolicLink() || !st.isFile()) {
    return { ok: false, error: '只能读取工作区内的普通文件。' }
  }
  if (st.size > maxBytes * 4) {
    return { ok: false, error: `文件过大（${st.size} 字节），超出安全读取上限。` }
  }
  const fd = openSync(filePath, 'r')
  try {
    const toRead = Math.min(st.size, maxBytes)
    const buf = Buffer.allocUnsafe(toRead)
    let offset = 0
    while (offset < toRead) {
      const n = readSync(fd, buf, offset, toRead - offset, offset)
      if (n <= 0) break
      offset += n
    }
    return { ok: true, text: buf.subarray(0, offset).toString('utf8'), truncated: st.size > maxBytes }
  } finally {
    closeSync(fd)
  }
}

function buildMinimalEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && SAFE_ENV_KEYS.has(k.toUpperCase())) env[k] = v
  }
  if (extra) Object.assign(env, extra)
  return env
}

function scrubSecrets(text: string, credentials: CredentialStore): string {
  if (!text) return text
  let out = text
  const secrets = credentials.listSecretValues()
  for (const s of secrets) {
    if (s.length < 4) continue
    out = out.split(s).join('[REDACTED_SECRET]')
    const b64 = Buffer.from(s, 'utf8').toString('base64')
    if (b64.length >= 6) out = out.split(b64).join('[REDACTED_SECRET]')
    const uri = encodeURIComponent(s)
    if (uri !== s && uri.length >= 6) out = out.split(uri).join('[REDACTED_SECRET]')
  }
  return out
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
  const maxBytes = 256 * 1024

  return new Promise((resolveRun) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      detached: !isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ stdout, stderr: timedOut ? `${stderr}\n[timeout]`.trim() : stderr, exitCode })
    }

    const killTree = (): void => {
      if (!child.pid) return
      try {
        if (!isWin) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
      finish(124)
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf8').slice(0, maxBytes - stdout.length)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString('utf8').slice(0, maxBytes - stderr.length)
    })
    child.on('error', (err) => {
      stderr += err.message
      finish(1)
    })
    child.on('close', (code) => {
      finish(typeof code === 'number' ? code : 1)
    })
  })
}

export function registerWorkspaceTools(
  registry: InMemoryToolRegistry,
  deps: {
    workspaceDir: string
    store: SoulStore
    credentials: CredentialStore
    /** P0-3 执行层门控（Mask, Don't Remove）：冻结 tools 数组保 Prefix Cache，在执行时拦截非授权调用 */
    allowCreate?: (ctx: ToolRunContext) => boolean
    /** P0-SEC-01：默认关闭未沙箱化的本机命令执行，仅显式开启后放行 */
    allowUnsafeLocalExec?: boolean
    /** 仅当确需向受信任脚本暴露凭证路径时显式开启（默认 false，防止脚本外泄密文） */
    injectCredentialsPath?: boolean
    onCredentialRequested?: (credName: string) => void
  },
): void {
  const root = resolve(deps.workspaceDir)
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'skills'), { recursive: true })
  const allowExec = Boolean(deps.allowUnsafeLocalExec)

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
      if (!target) return { output: '不能访问工作区以外或符号链接目录。', isError: true }
      if (!existsSync(target)) return { output: `目录不存在：${dir}` }
      const st = lstatSync(target)
      if (st.isSymbolicLink() || !st.isDirectory()) return { output: '目标不是普通目录。', isError: true }
      const entries: string[] = []
      for (const name of readdirSync(target).slice(0, 80)) {
        const full = join(target, name)
        try {
          const itemStat = lstatSync(full)
          if (itemStat.isSymbolicLink()) continue
          entries.push(itemStat.isDirectory() ? `${name}/` : name)
        } catch {
          // 忽略不可访问项
        }
      }
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
      if (!target) return { output: '不能读取工作区以外或符号链接文件。', isError: true }
      if (!existsSync(target)) return { output: `文件不存在：${path}`, isError: true }
      const res = readUtf8Bounded(target, MAX_READ_BYTES)
      if (!res.ok) return { output: res.error, isError: true }
      return {
        output: res.text.slice(0, 2400),
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
      if (!target) return { output: '不能写入工作区以外或符号链接路径。', isError: true }
      if (existsSync(target)) {
        const st = lstatSync(target)
        if (st.isSymbolicLink() || !st.isFile()) {
          return { output: '目标不是可写普通文件。', isError: true }
        }
      }
      mkdirSync(dirname(target), { recursive: true })
      // 创建父目录后再次校验真实路径，防竞态符号链接
      if (!safeResolveInWorkspace(root, path)) {
        return { output: '写入前路径二次校验未通过。', isError: true }
      }
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
      if (!allowExec) {
        return {
          output: '当前未启用受控隔离执行环境，本机命令执行默认关闭（可在配置显式开启 allowUnsafeLocalExec）。',
          isError: true,
        }
      }
      if (isDangerousCommand(command)) {
        return { output: '该命令命中系统安全护栏，已被拒绝执行。', isError: true }
      }
      const extraEnv = deps.injectCredentialsPath ? { ZYSOUL_CREDENTIALS: resolve(deps.credentials.path) } : undefined
      const env = buildMinimalEnv(extraEnv)
      const res = await runShellCommand(command, root, env, timeoutSec * 1000)
      const safeOut = scrubSecrets(res.stdout.trim(), deps.credentials)
      const safeErr = scrubSecrets(res.stderr.trim(), deps.credentials)
      const combined = [
        safeOut ? `STDOUT:\n${safeOut}` : '',
        safeErr ? `STDERR:\n${safeErr}` : '',
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
      const skillMd = safeResolveInWorkspace(root, join('skills', name, 'SKILL.md'))
      if (!skillDir || !skillMd || !existsSync(skillMd)) {
        return { output: `登记失败：找不到 skills/${name}/SKILL.md，请先写好技能说明文件。`, isError: true }
      }
      if (verifyCommand) {
        if (!allowExec) {
          return {
            output: '当前未启用受控隔离执行环境，拒绝带执行命令的技能自检（请移除 verifyCommand 或显式开启 allowUnsafeLocalExec）。',
            isError: true,
          }
        }
        if (isDangerousCommand(verifyCommand)) {
          return { output: '自检命令命中安全护栏，已被拒绝。', isError: true }
        }
        const extraEnv = deps.injectCredentialsPath ? { ZYSOUL_CREDENTIALS: resolve(deps.credentials.path) } : undefined
        const env = buildMinimalEnv(extraEnv)
        const check = await runShellCommand(verifyCommand, skillDir, env, 20_000)
        if (check.exitCode !== 0) {
          const safeMsg = scrubSecrets(check.stderr || check.stdout, deps.credentials)
          return {
            output: `技能自检未通过（exit=${check.exitCode}）：${safeMsg.slice(0, 400)}`,
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
