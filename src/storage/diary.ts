// 日记本（人类可读 Markdown，按日期单文件存储 data/bots/<id>/diary/YYYY-MM-DD.md）。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DiaryEntry {
  date: string
  content: string
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
    return readFileSync(p, 'utf8').trim()
  }

  write(date: string, content: string): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.pathFor(date), content.trim() + '\n', 'utf8')
  }

  list(limit = 30): DiaryEntry[] {
    if (!existsSync(this.dir)) return []
    const files = readdirSync(this.dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, limit)
    return files.map((f) => ({
      date: f.replace(/\.md$/, ''),
      content: readFileSync(join(this.dir, f), 'utf8').trim(),
    }))
  }
}
