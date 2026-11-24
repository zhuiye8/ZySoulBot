// 外部服务凭证库（data/credentials.json，0600 权限，原子写，无缓存防双端写过期）。
// 关键约定：填了就是同意。密钥绝不经过聊天记录；她登记需要、管理员在后台填、她的工具按名取值。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { nowLocal } from '../../shared/time.ts'

export const CredFieldSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  type: z.enum(['text', 'secret']).default('text'),
  required: z.boolean().default(false),
  placeholder: z.string().max(80).optional(),
  default: z.string().max(120).optional(),
})

export type CredField = z.infer<typeof CredFieldSchema>

export interface CredNeed {
  name: string
  label: string
  provider: string
  providerName?: string
  why?: string
  howto?: string
  fields: CredField[]
  createdAt: string
  askedAt?: string
}

export interface CredFilled {
  provider: string
  values: Record<string, string>
  filledAt: string
}

interface CredFileData {
  needs: Record<string, CredNeed>
  filled: Record<string, CredFilled>
}

export function normalizeCredFields(raw: unknown): CredField[] {
  if (!Array.isArray(raw)) return []
  const out: CredField[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const parsed = CredFieldSchema.safeParse(item)
    if (!parsed.success || seen.has(parsed.data.key)) continue
    seen.add(parsed.data.key)
    out.push(parsed.data)
    if (out.length >= 12) break
  }
  return out
}

export class CredentialStore {
  readonly path: string

  constructor(filePath: string) {
    this.path = filePath
  }

  private load(): CredFileData {
    if (!existsSync(this.path)) return { needs: {}, filled: {} }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CredFileData>
      const needs: Record<string, CredNeed> = {}
      for (const [k, v] of Object.entries(raw.needs ?? {})) {
        if (!v || typeof v !== 'object') continue
        needs[k] = { ...v, fields: normalizeCredFields(v.fields) }
      }
      return { needs, filled: raw.filled ?? {} }
    } catch {
      return { needs: {}, filled: {} }
    }
  }

  private save(data: CredFileData): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
  }

  listNeeds(): CredNeed[] {
    return Object.values(this.load().needs)
  }

  // 安全公开视图：绝不暴露任何 secret 字段明文，供管理后台渲染动态表单
  listPublic(): Array<CredNeed & { filled: boolean; filledAt: string | null; maskedValues: Record<string, string> }> {
    const d = this.load()
    return Object.values(d.needs).map((need) => {
      const filledRec = d.filled[need.name]
      const maskedValues: Record<string, string> = {}
      if (filledRec) {
        for (const f of need.fields) {
          const val = filledRec.values[f.key] ?? ''
          if (!val) continue
          maskedValues[f.key] = f.type === 'secret'
            ? (val.length > 6 ? `${val.slice(0, 2)}••••${val.slice(-2)}` : '••••••')
            : val
        }
      }
      return {
        ...need,
        filled: Boolean(filledRec),
        filledAt: filledRec?.filledAt ?? null,
        maskedValues,
      }
    })
  }

  getNeed(name: string): CredNeed | null {
    return this.load().needs[name] ?? null
  }

  isReady(name: string): boolean {
    return Boolean(this.load().filled[name])
  }

  readyLabels(): string[] {
    const d = this.load()
    return Object.values(d.needs)
      .filter((n) => Boolean(d.filled[n.name]))
      .map((n) => n.label)
  }

  getValues(name: string): Record<string, string> | null {
    return this.load().filled[name]?.values ?? null
  }

  // 登记或更新外部服务凭证需求；换供应商时自动作废旧密钥。
  registerNeed(inp: {
    name: string
    label: string
    provider: string
    providerName?: string
    why?: string
    howto?: string
    fields: CredField[]
    now?: Date
  }): { need: CredNeed; providerChanged: boolean } {
    const d = this.load()
    const cleanName = inp.name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40)
    const prev = d.needs[cleanName]
    const providerChanged = Boolean(prev && inp.provider && prev.provider !== inp.provider)
    const need: CredNeed = {
      name: cleanName,
      label: inp.label.trim().slice(0, 60) || cleanName,
      provider: inp.provider.trim().slice(0, 60),
      providerName: inp.providerName?.trim().slice(0, 60) || (!providerChanged ? prev?.providerName : undefined),
      why: inp.why?.trim().slice(0, 200) || prev?.why,
      howto: inp.howto?.trim().slice(0, 400) || (!providerChanged ? prev?.howto : undefined),
      fields: normalizeCredFields(inp.fields),
      createdAt: prev?.createdAt ?? nowLocal(inp.now),
      askedAt: providerChanged ? undefined : prev?.askedAt,
    }
    d.needs[cleanName] = need
    if (providerChanged && d.filled[cleanName]) {
      delete d.filled[cleanName]
    }
    this.save(d)
    return { need, providerChanged }
  }

  fill(name: string, values: Record<string, string>, provider?: string, now?: Date): boolean {
    const d = this.load()
    const need = d.needs[name]
    if (!need) return false
    const clean: Record<string, string> = {}
    for (const f of need.fields) {
      const v = String(values[f.key] ?? '').trim()
      if (v) clean[f.key] = v.slice(0, 2000)
    }
    for (const f of need.fields) {
      if (f.required && !clean[f.key]) return false
    }
    const prov = provider?.trim() || need.provider
    d.filled[name] = { provider: prov, values: clean, filledAt: nowLocal(now) }
    if (prov && prov !== need.provider) d.needs[name] = { ...need, provider: prov }
    this.save(d)
    return true
  }

  removeNeed(name: string): boolean {
    const d = this.load()
    if (!d.needs[name]) return false
    delete d.needs[name]
    delete d.filled[name]
    this.save(d)
    return true
  }

  markAsked(name: string, now?: Date): void {
    const d = this.load()
    const n = d.needs[name]
    if (!n) return
    d.needs[name] = { ...n, askedAt: nowLocal(now) }
    this.save(d)
  }

  dueAsk(nowMs = Date.now(), gapMs = 24 * 3_600_000): CredNeed | null {
    const d = this.load()
    for (const n of Object.values(d.needs)) {
      if (d.filled[n.name]) continue
      if (!n.askedAt) return n
      const last = Date.parse(n.askedAt.replace(' ', 'T'))
      if (!Number.isFinite(last) || nowMs - last >= gapMs) return n
    }
    return null
  }
}
