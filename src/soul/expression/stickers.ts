// 表情包领域库（按 bot 隔离）：manifest 热加载 + 情绪匹配 + 频控/去重 + 陌生人负面收敛。
// 零外部依赖；不解析回复正文里的假指令——由表达层原生工具 send_sticker 主动调用。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AffectKind } from '../../shared/ports.ts'

export interface StickerMeta {
  key: string
  file: string
  emotions: AffectKind[]
  tags?: string[]
  description?: string
  enabled?: boolean
  weight?: number
  uses?: number
}

export interface StickerPick {
  key: string
  file: string
  absPath: string
  description?: string
}

export interface StickerLibraryOptions {
  cooldownTurns?: number
  cooldownMs?: number
  recentK?: number
  strangerThreshold?: number
  random?: () => number
}

interface RouteState {
  recentKeys: string[]
  lastKind: string
  lastAt: number
  turnsSince: number
}

const NEGATIVE_AFFECTS = new Set<string>(['annoyed', 'hurt', 'rejected', 'conflict', 'sadness', 'uneasy'])
const AFFECTIONATE_AFFECTS = new Set<string>(['affection', 'praised'])

export class StickerLibrary {
  readonly dir: string
  readonly manifestPath: string
  readonly opts: Required<Omit<StickerLibraryOptions, 'random'>>
  private random: () => number
  private items: StickerMeta[] = []
  private mtime = 0
  private routes = new Map<string, RouteState>()

  constructor(dir: string, opts: StickerLibraryOptions = {}) {
    this.dir = dir
    this.manifestPath = join(dir, 'manifest.json')
    this.opts = {
      cooldownTurns: opts.cooldownTurns ?? 3,
      cooldownMs: opts.cooldownMs ?? 60_000,
      recentK: opts.recentK ?? 5,
      strangerThreshold: opts.strangerThreshold ?? 0.4,
    }
    this.random = opts.random ?? Math.random
    this.reload()
  }

  reload(): void {
    if (!existsSync(this.manifestPath)) {
      this.items = []
      this.mtime = 0
      return
    }
    let mt = 0
    try {
      mt = statSync(this.manifestPath).mtimeMs
    } catch {
      this.items = []
      return
    }
    if (mt === this.mtime) return
    this.mtime = mt
    try {
      const parsed = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as { items?: StickerMeta[] }
      this.items = Array.isArray(parsed.items)
        ? parsed.items.filter((s) => Boolean(s?.key && s?.file && Array.isArray(s.emotions)))
        : []
    } catch {
      this.items = []
    }
  }

  list(): StickerMeta[] {
    this.reload()
    return [...this.items]
  }

  get(key: string): StickerMeta | undefined {
    this.reload()
    return this.items.find((s) => s.key === key)
  }

  availableEmotions(): AffectKind[] {
    this.reload()
    const set = new Set<AffectKind>()
    for (const s of this.items) {
      if (s.enabled === false) continue
      for (const e of s.emotions) set.add(e)
    }
    return [...set]
  }

  private save(): void {
    mkdirSync(dirname(this.manifestPath), { recursive: true })
    const tmp = `${this.manifestPath}.tmp`
    writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2), 'utf8')
    renameSync(tmp, this.manifestPath)
    this.mtime = 0
  }

  upsert(meta: StickerMeta): void {
    this.reload()
    const idx = this.items.findIndex((s) => s.key === meta.key)
    if (idx >= 0) this.items[idx] = meta
    else this.items.push(meta)
    this.save()
  }

  remove(key: string): boolean {
    this.reload()
    const before = this.items.length
    this.items = this.items.filter((s) => s.key !== key)
    if (this.items.length === before) return false
    this.save()
    return true
  }

  tickRoute(route: string): void {
    const r = this.routes.get(route)
    if (r) r.turnsSince++
  }

  select(
    emotion: AffectKind,
    opts: { route: string; closeness?: number; strained?: boolean; force?: boolean; nowMs?: number },
  ): StickerPick | null {
    this.reload()
    const nowMs = opts.nowMs ?? Date.now()
    // 陌生人且没有冲突时，收敛负面表情；但若确实处于关系紧绷/生气期，允许发负面表情并收敛亲昵表情
    const maskNegative = !opts.strained && (opts.closeness ?? 0.5) < this.opts.strangerThreshold
    if (maskNegative && NEGATIVE_AFFECTS.has(emotion)) return null
    if (opts.strained && !opts.force && AFFECTIONATE_AFFECTS.has(emotion)) return null

    const r = this.routes.get(opts.route)
    if (r && !opts.force) {
      if (r.turnsSince < this.opts.cooldownTurns) return null
      if (nowMs - r.lastAt < this.opts.cooldownMs) return null
      if (r.lastKind === emotion && this.opts.recentK > 0) return null
    }

    let candidates = this.items.filter((s) => s.enabled !== false && s.emotions.includes(emotion))
    if (r?.recentKeys.length && this.opts.recentK > 0 && !opts.force) {
      const fresh = candidates.filter((s) => !r.recentKeys.includes(s.key))
      if (fresh.length > 0) candidates = fresh
    }
    if (candidates.length === 0) return null

    const totalWeight = candidates.reduce((sum, s) => sum + Math.max(0.1, s.weight ?? 1), 0)
    let roll = this.random() * totalWeight
    let picked = candidates[candidates.length - 1]!
    for (const s of candidates) {
      roll -= Math.max(0.1, s.weight ?? 1)
      if (roll <= 0) {
        picked = s
        break
      }
    }
    return {
      key: picked.key,
      file: picked.file,
      absPath: join(this.dir, picked.file),
      description: picked.description,
    }
  }

  noteSent(route: string, key: string, emotion: AffectKind, nowMs = Date.now()): void {
    const r = this.routes.get(route) ?? { recentKeys: [], lastKind: '', lastAt: 0, turnsSince: 0 }
    r.recentKeys = this.opts.recentK > 0 ? [...r.recentKeys, key].slice(-this.opts.recentK) : []
    r.lastKind = emotion
    r.lastAt = nowMs
    r.turnsSince = 0
    this.routes.set(route, r)
    const item = this.items.find((s) => s.key === key)
    if (item) {
      item.uses = (item.uses ?? 0) + 1
      this.save()
    }
  }
}
