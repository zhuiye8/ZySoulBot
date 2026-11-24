// 日记本（人类可读 Markdown，按日期单文件存储 data/bots/<id>/diary/YYYY-MM-DD.md）。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DiaryEntry {
  date: string
  content: string
}

// 去除正文开头重复的 `# YYYY-MM-DD` 标题，保证落盘永远只有唯一一行规范日期标题
export function stripLeadingDateHeaders(date: string, raw: string): string {
  const escaped = date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^(?:#+\\s*${escaped}\\s*\\r?\\n*)+`, 'i')
  return raw.trim().replace(re, '').trim()
}

export function normalizeDiaryMarkdown(date: string, raw: string): string {
  const body = stripLeadingDateHeaders(date, raw)
  if (!body) return ''
  return `# ${date}\n\n${body}`
}

export class DiaryBook {
  readonly dir: string

  constructor(botDir: string) {
    this.dir = join(botDir, 'diary')
    mkdirSync(this.dir, { recursive: true })
  }

  pathFor(date: string): string {
    return join(this.dir, `${date}.md`)
  }

  has(date: string): boolean {
    const p = this.pathFor(date)
    return existsSync(p) && readFileSync(p, 'utf8').trim().length > 0
  }

  read(date: string): string {
    const p = this.pathFor(date)
    if (!existsSync(p)) return ''
    return normalizeDiaryMarkdown(date, readFileSync(p, 'utf8'))
  }

  write(date: string, content: string): void {
    mkdirSync(this.dir, { recursive: true })
    const normalized = normalizeDiaryMarkdown(date, content)
    writeFileSync(this.pathFor(date), `${normalized}\n`, 'utf8')
  }

  list(limit = 30): DiaryEntry[] {
    if (!existsSync(this.dir)) return []
    const files = readdirSync(this.dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, limit)
    return files.map((f) => {
      const date = f.replace(/\.md$/, '')
      return {
        date,
        content: normalizeDiaryMarkdown(date, readFileSync(join(this.dir, f), 'utf8')),
      }
    })
  }
}
