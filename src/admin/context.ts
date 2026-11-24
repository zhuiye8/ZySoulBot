// Admin 后端上下文契约：供 src/admin/ 使用，避免反向依赖 src/app.ts（保持零循环依赖）。
import type { BotConfig } from '../shared/config.ts'
import type { SingingPort, TransportPort, TtsPort } from '../shared/ports.ts'
import type { Clock } from '../shared/time.ts'
import type { DiaryBook } from '../storage/diary.ts'
import type { Soul } from '../soul/index.ts'
import type { CredentialStore } from '../soul/governance/credentials.ts'
import type { StickerLibrary } from '../soul/expression/stickers.ts'

export interface AdminBotContext {
  config: BotConfig
  botDir: string
  personaDir: string
  soul: Soul
  diary: DiaryBook
  credentials: CredentialStore
  stickers: StickerLibrary | null
  tts: TtsPort | null
  singing: SingingPort | null
  transport: TransportPort | null
  reloadPersona(): void
  /** P1-STATE-04：将后台状态写操作串行排入单 Bot 队列，避免与进行中的异步任务竞态覆盖 */
  runSerialized<T>(fn: () => Promise<T> | T): Promise<T>
}

export interface AdminContext {
  bots: AdminBotContext[]
  authFilePath: string
  webDistDir?: string
  initialPassword?: string
  trustProxy?: boolean
  clock?: Clock
  getBot(id: string): AdminBotContext | undefined
}
