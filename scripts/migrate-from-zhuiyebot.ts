// 一次性旧数据迁移脚本（只读源目录，绝不修改旧 zhuiyebot/data）：
// 用法：node scripts/migrate-from-zhuiyebot.ts --from ../zhuiyebot/data/bots/nahida --to ./data/bots/nahida [--dry-run]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SqliteSoulStore } from '../src/storage/sqlite-store.ts'
import type {
  AffectKind,
  DesireRecord,
  MemoryItem,
  RelationRecord,
} from '../src/shared/ports.ts'
import { EMOTION_KINDS } from '../src/shared/ports.ts'
import { nowLocal } from '../src/shared/time.ts'

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

function asAffect(raw: unknown): AffectKind | null {
  if (typeof raw !== 'string') return null
  return (EMOTION_KINDS as readonly string[]).includes(raw) ? (raw as AffectKind) : null
}

function readJsonSafe<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function main(): void {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法: node scripts/migrate-from-zhuiyebot.ts --from <旧bot数据目录> --to <新zySoulbot数据目录> [--dry-run]')
    return
  }

  const fromArg = argValue('--from')
  const toArg = argValue('--to')
  const dryRun = process.argv.includes('--dry-run')
  if (!fromArg || !toArg) {
    console.error('请提供 --from 和 --to 目录路径（可加 --dry-run 预演）')
    process.exit(1)
  }

  const srcDir = resolve(fromArg)
  const dstDir = resolve(toArg)
  if (!existsSync(srcDir)) {
    console.error(`源目录不存在：${srcDir}`)
    process.exit(1)
  }

  const stats = { memories: 0, relations: 0, desires: 0, diaryFiles: 0, stickersCopied: false, bodyImported: false }
  const store = dryRun ? null : new SqliteSoulStore(join(dstDir, 'soul.db'))

  try {
    // 1) 记忆池 items.jsonl
    const memPath = join(srcDir, 'memory', 'items.jsonl')
    if (existsSync(memPath)) {
      const lines = readFileSync(memPath, 'utf8').split('\n').filter((l) => l.trim())
      for (const line of lines) {
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const text = String(obj.text ?? '').trim()
        if (!text) continue
        const kindRaw = String(obj.kind ?? 'fact')
        const kind: MemoryItem['kind'] = (['experience', 'fact', 'concern', 'insight'] as const).includes(kindRaw as MemoryItem['kind'])
          ? (kindRaw as MemoryItem['kind'])
          : 'fact'
        const sensRaw = String(obj.sensitivity ?? 'personal')
        const sensitivity: MemoryItem['sensitivity'] = (['open', 'personal', 'private', 'critical'] as const).includes(sensRaw as MemoryItem['sensitivity'])
          ? (sensRaw as MemoryItem['sensitivity'])
          : 'personal'
        const tierRaw = String(obj.tier ?? 'season')
        const tier: MemoryItem['tier'] = (['fleeting', 'season', 'lasting', 'permanent'] as const).includes(tierRaw as MemoryItem['tier'])
          ? (tierRaw as MemoryItem['tier'])
          : 'season'
        const discRaw = String(obj.disclosable ?? 'when-asked')
        const disclosable: MemoryItem['disclosable'] = (['volunteer', 'when-asked', 'secretive'] as const).includes(discRaw as MemoryItem['disclosable'])
          ? (discRaw as MemoryItem['disclosable'])
          : 'when-asked'
        const about = Array.isArray(obj.about) ? obj.about.map(String) : []
        const srcRaw = String(obj.source ?? 'private')
        const source: MemoryItem['source'] = srcRaw === 'group' || srcRaw === 'life' ? srcRaw : 'private'

        store?.addMemory({
          id: typeof obj.id === 'string' ? obj.id : undefined,
          kind,
          text,
          about,
          sensitivity,
          tier,
          disclosable,
          consented: Boolean(obj.consented),
          source,
          threadKey: String(obj.threadKey ?? obj.route ?? 'legacy'),
          affect: asAffect(obj.affect),
          createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : nowLocal(),
        })
        stats.memories++
      }
    }

    // 2) 人物关系 relationships.json（兼容 state/ 与根目录两种布局）
    const relPath = existsSync(join(srcDir, 'state', 'relationships.json'))
      ? join(srcDir, 'state', 'relationships.json')
      : join(srcDir, 'relationships.json')
    const relsRaw = readJsonSafe<Record<string, Record<string, unknown>>>(relPath)
    if (relsRaw && typeof relsRaw === 'object') {
      const entries = (relsRaw.people && typeof relsRaw.people === 'object')
        ? Object.entries(relsRaw.people as Record<string, Record<string, unknown>>)
        : Object.entries(relsRaw)
      for (const [uid, r] of entries) {
        if (!r || typeof r !== 'object' || uid === 'version') continue
        const rec: RelationRecord = {
          userId: uid,
          callName: typeof r.callName === 'string' ? r.callName : (typeof r.call === 'string' ? r.call : null),
          customCall: Boolean(r.customCall),
          type: typeof r.type === 'string' ? r.type : 'friend',
          stage: typeof r.stage === 'string' ? r.stage : 'acquaintance',
          trust: Number(r.trust ?? 0.35),
          closeness: Number(r.closeness ?? 0.3),
          valence: Number(r.valence ?? 0.15),
          turns: Number(r.turns ?? 0),
          firstSeen: typeof r.firstSeen === 'string' ? r.firstSeen : null,
          lastSeen: typeof r.lastSeen === 'string' ? r.lastSeen : null,
          feels: [],
          streaks: {},
          windows: {},
          tensions: [],
        }
        store?.saveRelation(rec)
        stats.relations++
      }
    }

    // 3) 欲望 desires.json（兼容 state/ 与根目录）
    const desPath = existsSync(join(srcDir, 'state', 'desires.json'))
      ? join(srcDir, 'state', 'desires.json')
      : join(srcDir, 'desires.json')
    const desiresRaw = readJsonSafe<{ items?: Array<Record<string, unknown>>; desires?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(desPath)
    const desireArr = Array.isArray(desiresRaw) ? desiresRaw : (desiresRaw?.items ?? desiresRaw?.desires ?? [])
    for (const d of desireArr) {
      const want = String(d.want ?? '').trim()
      if (!want) continue
      const rec: DesireRecord = {
        id: typeof d.id === 'string' ? d.id : `des_${stats.desires + 1}`,
        source: 'chat',
        motive: String(d.motive ?? 'curiosity'),
        want,
        why: String(d.why ?? ''),
        exitKind: 'experience',
        stage: d.stage === 'fulfilled' || d.stage === 'abandoned' || d.stage === 'faded' ? d.stage : 'seed',
        spec: null,
        blocker: null,
        strength: Number(d.strength ?? 0.5),
        thoughtCount: Number(d.thoughtCount ?? 1),
        progressNote: typeof d.progressNote === 'string' ? d.progressNote : null,
        aboutUser: typeof d.aboutUser === 'string' ? d.aboutUser : null,
        parentId: null,
        createdAt: typeof d.createdAt === 'string' ? d.createdAt : nowLocal(),
        updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : nowLocal(),
      }
      store?.upsertDesire(rec)
      stats.desires++
    }

    // 4) 身心状态 state.json（兼容 state/ 与根目录）
    const statePath = existsSync(join(srcDir, 'state', 'state.json'))
      ? join(srcDir, 'state', 'state.json')
      : join(srcDir, 'state.json')
    const stateRaw = readJsonSafe<Record<string, unknown>>(statePath)
    if (stateRaw && typeof stateRaw.pad === 'object' && stateRaw.pad) {
      const pad = stateRaw.pad as { p?: number; a?: number; d?: number }
      const mood = (stateRaw.mood as { p?: number; a?: number; d?: number } | undefined) ?? pad
      const now = nowLocal()
      store?.saveBodyState({
        pad: { p: Number(pad.p ?? 0.15), a: Number(pad.a ?? 0), d: Number(pad.d ?? 0.1) },
        mood: { p: Number(mood.p ?? 0.15), a: Number(mood.a ?? 0), d: Number(mood.d ?? 0.1) },
        drives: (stateRaw.drives as Record<string, number> | undefined) ?? {},
        energy: Number(stateRaw.energy ?? 0.8),
        sleepDebt: Number(stateRaw.sleepDebt ?? 0),
        activity: null,
        lastTickAt: now,
        updatedAt: now,
      })
      stats.bodyImported = true
    }

    // 5) 日记与表情包文件复制（非破坏性，兼容 memory/diary 与 diary）
    const srcDiary = existsSync(join(srcDir, 'memory', 'diary'))
      ? join(srcDir, 'memory', 'diary')
      : join(srcDir, 'diary')
    if (existsSync(srcDiary)) {
      const mdFiles = readdirSync(srcDiary).filter((f) => f.endsWith('.md'))
      stats.diaryFiles = mdFiles.length
      if (!dryRun && mdFiles.length > 0) {
        mkdirSync(join(dstDir, 'diary'), { recursive: true })
        cpSync(srcDiary, join(dstDir, 'diary'), { recursive: true, force: false })
      }
    }

    const srcStickers = join(srcDir, 'stickers')
    if (existsSync(srcStickers)) {
      stats.stickersCopied = true
      if (!dryRun) {
        mkdirSync(join(dstDir, 'stickers'), { recursive: true })
        cpSync(srcStickers, join(dstDir, 'stickers'), { recursive: true, force: false })
      }
    }

    console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'migrated', from: srcDir, to: dstDir, stats }, null, 2))
  } finally {
    store?.close()
  }
}

main()
