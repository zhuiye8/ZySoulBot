// 文件系统人设包加载适配器（将 node:fs I/O 隔离在 storage 层，保持 soul/ 纯净）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PackManifestSchema, parsePersonaPack } from '../soul/persona/pack.ts'
import type { PersonaPack } from '../soul/persona/pack.ts'

function readOptionalText(filePath: string): string {
  if (!existsSync(filePath)) return ''
  return readFileSync(filePath, 'utf8').trim()
}

export function loadPersonaPack(packDir: string): PersonaPack {
  const manifestPath = join(packDir, 'pack.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`找不到人设包清单：${manifestPath}`)
  }
  const manifestJson = readFileSync(manifestPath, 'utf8')
  const parsed = PackManifestSchema.parse(JSON.parse(manifestJson))
  const dir = join(packDir, parsed.content_dir)

  const lorePath = join(dir, 'lore.json')
  const actPath = join(packDir, 'activities.json')

  return parsePersonaPack({
    manifestJson,
    identity: readOptionalText(join(dir, parsed.content.identity)),
    origin: parsed.content.origin ? readOptionalText(join(dir, parsed.content.origin)) : '',
    examples: parsed.content.examples ? readOptionalText(join(dir, parsed.content.examples)) : '',
    worldview: parsed.content.worldview ? readOptionalText(join(dir, parsed.content.worldview)) : '',
    scenario: parsed.content.scenario ? readOptionalText(join(dir, parsed.content.scenario)) : '',
    discipline: parsed.content.discipline ? readOptionalText(join(dir, parsed.content.discipline)) : '',
    greeting: parsed.content.greeting ? readOptionalText(join(dir, parsed.content.greeting)) : '',
    loreJson: existsSync(lorePath) ? readFileSync(lorePath, 'utf8') : null,
    activitiesJson: existsSync(actPath) ? readFileSync(actPath, 'utf8') : null,
  })
}
