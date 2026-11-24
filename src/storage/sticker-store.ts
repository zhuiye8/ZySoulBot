// 表情包文件系统存储适配器（将 node:fs I/O 隔离在 storage 层，保持 soul/ 纯净）。
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { StickerLibrary } from '../soul/expression/stickers.ts'
import type { StickerLibraryOptions, StickerMeta, StickerStorageBackend } from '../soul/expression/stickers.ts'

export function createFileStickerBackend(dir: string): StickerStorageBackend {
  const manifestPath = join(dir, 'manifest.json')
  return {
    dir,
    manifestPath,
    getMtime(): number {
      if (!existsSync(manifestPath)) return 0
      try {
        return statSync(manifestPath).mtimeMs
      } catch {
        return 0
      }
    },
    readManifest(): StickerMeta[] {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { items?: StickerMeta[] }
        return Array.isArray(parsed.items)
          ? parsed.items.filter((s) => Boolean(s?.key && s?.file && Array.isArray(s.emotions)))
          : []
      } catch {
        return []
      }
    },
    writeManifest(items: StickerMeta[]): void {
      mkdirSync(dirname(manifestPath), { recursive: true })
      const tmp = `${manifestPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8')
      renameSync(tmp, manifestPath)
    },
    resolveFile(file: string): string {
      return join(dir, file)
    },
  }
}

export class FileStickerLibrary extends StickerLibrary {
  constructor(dir: string, opts: StickerLibraryOptions = {}) {
    super(createFileStickerBackend(dir), opts)
  }
}

export { FileStickerLibrary as StickerLibrary }
