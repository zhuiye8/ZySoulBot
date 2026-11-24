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

export class InMemoryToolRegistry implements ToolRegistry {
  private map = new Map<string, RegisteredTool>()

  register(tool: RegisteredTool): void {
    this.map.set(tool.spec.name, tool)
  }

  list(layers: ToolLayer[]): ToolSpec[] {
    const allowed = new Set(layers)
    return [...this.map.values()]
      .filter((t) => allowed.has(t.layer))
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
  deps: { store: SoulStore; persona: PersonaPack },
): void {
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
    async execute(args) {
      const { query } = RecallArgsSchema.parse(args)
      const hits = deps.store.searchMemories(query, 8)
      if (hits.length === 0) {
        return { output: `翻了翻记忆，没找到关于「${query}」的记录。`, foldSummary: `回忆「${query}」：未找到` }
      }
      const lines = hits.map((m) => `- [${m.createdAt.slice(0, 10)}] (${m.kind}) ${m.text}`)
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
