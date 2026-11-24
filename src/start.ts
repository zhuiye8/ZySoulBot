// 进程入口：读取并 Zod 校验 zysoul.config.json（支持字符串值用 env:VAR_NAME 从环境变量取值），启动 zySoulbot。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ZysoulConfigSchema } from './shared/config.ts'
import { createApp } from './app.ts'

function resolveEnvRefs(node: unknown): unknown {
  if (typeof node === 'string' && node.startsWith('env:')) {
    const key = node.slice(4).trim()
    return process.env[key] ?? ''
  }
  if (Array.isArray(node)) return node.map(resolveEnvRefs)
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) out[k] = resolveEnvRefs(v)
    return out
  }
  return node
}

async function main(): Promise<void> {
  const cfgPath = resolve(process.argv[2] ?? 'zysoul.config.json')
  const raw: unknown = resolveEnvRefs(JSON.parse(readFileSync(cfgPath, 'utf8')))
  const config = ZysoulConfigSchema.parse(raw)
  const app = createApp(config)
  await app.start()
  console.log(`[ZySoulBot] started ${app.bots.length} bot(s)${config.admin ? ` · admin http://${config.admin.host}:${config.admin.port}` : ''}`)

  const shutdown = async (): Promise<void> => {
    console.log('[ZySoulBot] shutting down...')
    await app.dispose()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

main().catch((err) => {
  console.error('[zySoulbot] fatal:', err)
  process.exit(1)
})
