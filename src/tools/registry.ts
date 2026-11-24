// 工具注册表 + 首批灵魂内生探索工具（按需翻记忆 / 翻世界观，省 token 不全量硬塞）。
import { z } from 'zod'
import type {
  RegisteredTool,
  SoulStore,
  ToolLayer,
  ToolRegistry,
  ToolSpec,
} from '../shared/ports.ts'
import type { PersonaPack } from '../soul/persona/pack.ts'
import { intimacyTierOf, MemoryEngine } from '../soul/memory/engine.ts'

function canonicalizeJson(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(canonicalizeJson)
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(val as Record<string, unknown>).sort()) {
      out[key] = canonicalizeJson((val as Record<string, unknown>)[key])
    }
    return out
  }
  return val
}

export class InMemoryToolRegistry implements ToolRegistry {
  private map = new Map<string, RegisteredTool>()

  register(tool: RegisteredTool): void {
    const normalized: RegisteredTool = {
      ...tool,
      spec: {
        ...tool.spec,
        parameters: canonicalizeJson(tool.spec.parameters) as Record<string, unknown>,
      },
    }
    this.map.set(tool.spec.name, normalized)
  }

  // P0-3：按工具名严格字典序稳定输出，保证同一会话内 tools JSON 字节级冻结以保 Prefix Cache
  list(layers: ToolLayer[]): ToolSpec[] {
    const allowed = new Set(layers)
    return [...this.map.values()]
      .filter((t) => allowed.has(t.layer))
      .sort((a, b) => a.spec.name.localeCompare(b.spec.name))
      .map((t) => t.spec)
  }

  get(name: string): RegisteredTool | undefined {
    return this.map.get(name)
  }
}

const RecallArgsSchema = z.object({
  query: z.string().min(1).max(60),
})

const WorldviewArgsSchema = z.object({
  topic: z.string().min(1).max(40),
})

export function registerSelfExplorationTools(
  registry: InMemoryToolRegistry,
  deps: { store: SoulStore; persona: PersonaPack; memory?: MemoryEngine },
): void {
  const memory = deps.memory ?? new MemoryEngine(deps.store)

  registry.register({
    layer: 'explore',
    spec: {
      name: 'recall_memory',
      description: '从自己的长期记忆里按关键词翻找以前发生过的事或别人说过的话。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '想回忆的关键词（人名、地点、事件）' },
        },
        required: ['query'],
      },
    },
    async execute(args, ctx) {
      const { query } = RecallArgsSchema.parse(args)
      const rel = ctx.userId ? deps.store.getRelation(ctx.userId) : null
      const tier = intimacyTierOf(rel?.stage ?? 'stranger')
      const hits = memory.searchVisible({
        query,
        listener: ctx.userId,
        tier,
        isGroup: ctx.isGroup,
        solo: ctx.solo,
        limit: 8,
        nameOf: (u) => deps.store.getRelation(u)?.callName ?? u,
      })
      if (hits.length === 0) {
        return { output: `翻了翻记忆，没找到关于「${query}」的记录。`, foldSummary: `回忆「${query}」：未找到` }
      }
      const lines = hits.map(({ item, text }) => {
        const provTag = item.provenance === 'L2_internal' ? '[随想] ' : ''
        return `- [${item.createdAt.slice(0, 10)}] (${item.kind}) ${provTag}${text}`
      })
      return {
        output: lines.join('\n'),
        foldSummary: `回忆「${query}」：想起 ${hits.length} 条`,
      }
    },
  })

  registry.register({
    layer: 'explore',
    spec: {
      name: 'read_worldview',
      description: '翻看自己世界里某个地点、人物或概念的记忆细节。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '想查的世界词条，例如 须弥、世界树、教令院' },
        },
        required: ['topic'],
      },
    },
    async execute(args) {
      const { topic } = WorldviewArgsSchema.parse(args)
      const matched = deps.persona.worldSections.filter(
        (s) => s.title.includes(topic) || s.body.includes(topic),
      )
      if (matched.length === 0) {
        return { output: `没有找到关于「${topic}」的世界设定条目。` }
      }
      return {
        output: matched.map((s) => s.body).join('\n\n').slice(0, 1800),
        foldSummary: `查阅世界记忆「${topic}」`,
      }
    },
  })
}
