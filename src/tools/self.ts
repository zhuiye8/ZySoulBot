// 她自己的生活与内心工具：读/写日记本、记提醒、记下心里新冒出的念头。
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SoulStore } from '../shared/ports.ts'
import { nowLocal, todayLocal } from '../shared/time.ts'
import type { DiaryBook } from '../storage/diary.ts'
import type { InMemoryToolRegistry } from './registry.ts'

const ReadDiaryArgsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

const WriteDiaryArgsSchema = z.object({
  content: z.string().min(5).max(3000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

const SetReminderArgsSchema = z.object({
  text: z.string().min(1).max(140),
  dueAtIso: z.string().min(10),
})

const NoteThoughtArgsSchema = z.object({
  want: z.string().min(2).max(120),
  why: z.string().min(2).max(160),
  exitKind: z.enum(['experience', 'create_work', 'social', 'build_skill']).default('experience'),
})

export function registerSelfLifeTools(
  registry: InMemoryToolRegistry,
  deps: { store: SoulStore; diary: DiaryBook },
): void {
  registry.register({
    layer: 'explore',
    spec: {
      name: 'read_diary',
      description: '翻看自己写的日记（可指定日期 YYYY-MM-DD，不填则看最近 2 篇）。',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: '可选日期，格式 YYYY-MM-DD' },
        },
      },
    },
    async execute(args) {
      const { date } = ReadDiaryArgsSchema.parse(args)
      if (date) {
        const text = deps.diary.read(date)
        return {
          output: text || `${date} 那天没有写日记。`,
          foldSummary: `翻了 ${date} 的日记`,
        }
      }
      const list = deps.diary.list(2)
      if (list.length === 0) return { output: '日记本还是空的。' }
      const rendered = list.map((d) => `### ${d.date}\n${d.content.slice(0, 700)}`).join('\n\n')
      return {
        output: rendered,
        foldSummary: `翻了最近 ${list.length} 篇日记`,
      }
    },
  })

  registry.register({
    layer: 'create',
    spec: {
      name: 'write_diary',
      description: '把今天自己的感受和真实发生的事写进日记本（属于你自己的回忆）。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '日记正文，用第一人称' },
          date: { type: 'string', description: '可选日期 YYYY-MM-DD，默认今天' },
        },
        required: ['content'],
      },
    },
    async execute(args, ctx) {
      const { content, date } = WriteDiaryArgsSchema.parse(args)
      const targetDate = date ?? todayLocal(ctx.now)
      deps.diary.write(targetDate, content)
      return {
        output: `已经把 ${targetDate} 的日记写进本子里了。`,
        foldSummary: `写了 ${targetDate} 的日记`,
      }
    },
  })

  registry.register({
    layer: 'explore',
    spec: {
      name: 'set_reminder',
      description: '记下一个明确时间的提醒或约定，到点会准时想起去喊对方。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '提醒内容，如「喊他起床」「提醒他开会」' },
          dueAtIso: { type: 'string', description: '到期时间（ISO 8601 格式，如 2026-11-25T07:00:00+08:00）' },
        },
        required: ['text', 'dueAtIso'],
      },
    },
    async execute(args, ctx) {
      const { text, dueAtIso } = SetReminderArgsSchema.parse(args)
      const ts = Date.parse(dueAtIso)
      if (!Number.isFinite(ts)) {
        return { output: '时间格式不对，没法记下提醒。', isError: true }
      }
      const id = `rem_${randomUUID().slice(0, 8)}`
      deps.store.addSchedule({
        id,
        kind: 'reminder',
        userId: ctx.userId,
        threadKey: ctx.threadKey,
        text,
        dueAt: new Date(ts).toISOString(),
        status: 'pending',
        createdAt: nowLocal(ctx.now),
      })
      return {
        output: `记下了提醒（${new Date(ts).toLocaleString('zh-CN')}）：${text}`,
        foldSummary: `记了提醒：${text}`,
      }
    },
  })

  registry.register({
    layer: 'explore',
    spec: {
      name: 'note_thought',
      description: '把自己心里刚冒出来想做、想学、想唱或想查的一件事记进心事本里。',
      parameters: {
        type: 'object',
        properties: {
          want: { type: 'string', description: '第一人称一句话：我想做什么' },
          why: { type: 'string', description: '为什么突然想做这件事' },
          exitKind: { type: 'string', enum: ['experience', 'create_work', 'social', 'build_skill'] },
        },
        required: ['want', 'why'],
      },
    },
    async execute(args, ctx) {
      const { want, why, exitKind } = NoteThoughtArgsSchema.parse(args)
      const now = nowLocal(ctx.now)
      deps.store.upsertDesire({
        id: `d_${randomUUID().slice(0, 10)}`,
        source: ctx.solo ? 'diary' : 'chat',
        motive: 'curiosity',
        want,
        why,
        exitKind,
        stage: 'active',
        spec: null,
        blocker: null,
        strength: 0.55,
        thoughtCount: 1,
        progressNote: null,
        aboutUser: ctx.solo ? null : ctx.userId,
        parentId: null,
        createdAt: now,
        updatedAt: now,
      })
      return {
        output: `已经记在心里了：${want}`,
        foldSummary: `记下念头：${want.slice(0, 30)}`,
      }
    },
  })
}
