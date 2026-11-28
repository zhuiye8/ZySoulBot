import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Music2,
  Play,
  Pause,
  Image as ImageIcon,
  Trash2,
  Volume2,
  FileText,
} from 'lucide-react'
import { api } from '../lib/api.ts'
import type { StickerItem, WorkItem } from '../lib/api.ts'
import {
  AlertDialog,
  Badge,
  Button,
  Dropzone,
  EmptyState,
  ErrorState,
  FilterChip,
  UnderlineTabs,
  useDelayedLoading,
} from '../components/ui.tsx'
import type { BadgeTone } from '../components/ui.tsx'

const EMOTIONS = ['all', 'praised', 'affection', 'humor', 'curiosity', 'annoyed', 'hurt', 'sadness', 'uneasy', 'guilty', 'boredom', 'rejected', 'conflict', 'neutral'] as const

const EMOTION_LABEL: Record<string, string> = {
  all: '全部',
  praised: '开心',
  affection: '亲近',
  humor: '俏皮',
  curiosity: '好奇',
  annoyed: '烦躁',
  hurt: '委屈',
  sadness: '难过',
  uneasy: '不安',
  guilty: '愧疚',
  boredom: '犯困',
  rejected: '受挫',
  conflict: '生气',
  neutral: '平静',
}

const TTS_MOOD_PRESETS: Array<{ id: string; label: string }> = [
  { id: 'neutral', label: '平静（基线）' },
  { id: 'praised', label: '开心明朗' },
  { id: 'affection', label: '温柔亲近' },
  { id: 'curiosity', label: '好奇活泼' },
  { id: 'humor', label: '俏皮逗趣' },
  { id: 'hurt', label: '委屈低落' },
  { id: 'sadness', label: '难过叹息' },
  { id: 'guilty', label: '愧疚轻声' },
  { id: 'annoyed', label: '烦躁不耐' },
  { id: 'conflict', label: '冷淡生气' },
  { id: 'boredom', label: '深夜犯困' },
]

const WORK_KIND_LABEL: Record<WorkItem['kind'], string> = {
  song: '歌曲',
  poem: '诗作',
  note: '笔记',
  image: '画作',
}

const WORK_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  ready: { label: '已完成', tone: 'ok' },
  generating: { label: '制作中', tone: 'info' },
  draft: { label: '草稿', tone: 'neutral' },
  failed: { label: '失败', tone: 'danger' },
}

export type WorksTab = 'songs' | 'stickers' | 'tts'

export function WorksView({
  botId,
  initialTab,
  onTabChange,
}: {
  botId: string
  initialTab?: string
  onTabChange?: (tab: WorksTab) => void
}) {
  const validTab: WorksTab = initialTab === 'stickers' || initialTab === 'tts' ? initialTab : 'songs'
  const [tab, setTab] = useState<WorksTab>(validTab)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [works, setWorks] = useState<WorkItem[]>([])
  const [hasSinging, setHasSinging] = useState(false)
  const [hasTts, setHasTts] = useState(false)
  const [activeWork, setActiveWork] = useState<WorkItem | null>(null)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const [stickers, setStickers] = useState<StickerItem[]>([])
  const [filterEmotion, setFilterEmotion] = useState<string>('all')
  const [uploading, setUploading] = useState(false)
  const [deleteStickerTarget, setDeleteStickerTarget] = useState<StickerItem | null>(null)
  const [deletingSticker, setDeletingSticker] = useState(false)

  const [ttsText, setTtsText] = useState('你好呀，今天过得怎么样？')
  const [ttsEmotion, setTtsEmotion] = useState<string>('neutral')
  const [ttsTone, setTtsTone] = useState('')
  const [ttsLoading, setTtsLoading] = useState(false)
  const [ttsError, setTtsError] = useState('')
  const ttsInputRef = useRef<HTMLInputElement | null>(null)
  const showSkeleton = useDelayedLoading(loading && works.length === 0 && stickers.length === 0, 180)

  useEffect(() => {
    setTab(validTab)
  }, [validTab])

  const switchTab = (next: WorksTab) => {
    setTab(next)
    onTabChange?.(next)
  }

  const loadAll = async () => {
    setLoading(true)
    setError('')
    try {
      const [w, s] = await Promise.all([api.works(botId), api.stickers(botId)])
      setWorks(w.works)
      setHasSinging(w.hasSinging)
      setHasTts(w.hasTts)
      setActiveWork((prev) => prev ?? w.works[0] ?? null)
      setStickers(s.items)
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setActiveWork(null)
    setPlaying(false)
    void loadAll()
  }, [botId])

  const togglePlay = (work: WorkItem) => {
    if (!work.hasAudio) return
    const audio = audioRef.current
    if (!audio) return
    if (activeWork?.id === work.id && playing) {
      audio.pause()
      setPlaying(false)
      return
    }
    setActiveWork(work)
    audio.src = `/api/bots/${encodeURIComponent(botId)}/works/${encodeURIComponent(work.id)}/audio`
    void audio.play().then(() => setPlaying(true)).catch((e) => toast.error((e as Error).message))
  }

  const handleUploadSticker = async (file: File) => {
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('autoTag', 'true')
      const res = await api.uploadSticker(botId, form)
      setStickers((prev) => [...prev, res.sticker])
      toast.success(`上传成功，已识别情绪：${res.sticker.emotions.join('、')}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const confirmDeleteSticker = async () => {
    if (!deleteStickerTarget) return
    setDeletingSticker(true)
    try {
      await api.deleteSticker(botId, deleteStickerTarget.key)
      setStickers((prev) => prev.filter((s) => s.key !== deleteStickerTarget.key))
      setDeleteStickerTarget(null)
      toast.success('已删除这张表情包')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeletingSticker(false)
    }
  }

  const runTtsPreview = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!hasTts) {
      setTtsError('当前角色尚未配置 TTS 服务，请先在配置文件中添加 tts 参数。')
      return
    }
    if (!ttsText.trim()) {
      setTtsError('请输入一句需要合成试听的文本。')
      ttsInputRef.current?.focus()
      return
    }
    setTtsError('')
    setTtsLoading(true)
    try {
      const blob = await api.ttsPreviewBlob(botId, ttsText.trim(), { emotion: ttsEmotion, tone: ttsTone })
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.onended = () => URL.revokeObjectURL(url)
      audio.onerror = () => URL.revokeObjectURL(url)
      await audio.play()
    } catch (err) {
      const msg = (err as Error).message
      setTtsError(`${msg}，请检查 TTS 密钥与音色配置后重试。`)
      toast.error(msg)
    } finally {
      setTtsLoading(false)
    }
  }

  const shownStickers = filterEmotion === 'all'
    ? stickers
    : stickers.filter((s) => s.emotions.includes(filterEmotion))

  return (
    <div className="space-y-6">
      <audio ref={audioRef} onEnded={() => setPlaying(false)} className="hidden" />

      <UnderlineTabs
        ariaLabel="声音与作品视图切换"
        value={tab}
        onChange={switchTab}
        items={[
          { id: 'songs', label: '作品与歌单', icon: Music2, count: works.length },
          { id: 'stickers', label: '表情包图库', icon: ImageIcon, count: stickers.length },
          { id: 'tts', label: '语音试听', icon: Volume2 },
        ]}
      />

      {error && <ErrorState title="无法加载作品与图库" message={error} onRetry={() => { void loadAll() }} />}

      {showSkeleton && (
        <div className="ui-panel p-6 space-y-3">
          <div className="ui-skeleton h-5 w-40" />
          <div className="ui-skeleton h-28 w-full" />
        </div>
      )}

      {/* 1) 作品与歌单（歌曲 / 诗作 / 笔记统一主从浏览） */}
      {!showSkeleton && tab === 'songs' && (
        <section className="ui-panel overflow-hidden">
          <div
            className="px-5 py-3.5 border-b flex flex-wrap items-center justify-between gap-2"
            style={{ borderColor: 'var(--gray-6)' }}
          >
            <h2 className="text-[15px] font-semibold">作品集与歌单</h2>
            <Badge tone={hasSinging ? 'ok' : 'neutral'}>
              {hasSinging ? 'Mureka 唱歌已接入' : '未配置 Mureka 唱歌'}
            </Badge>
          </div>

          {works.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="作品集还是空的"
              description="当她兴起写诗、保存手工设计笔记，或为你填词唱一首歌时，作品会自动收录在这里。"
            />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[420px]">
              <aside
                className="lg:col-span-4 border-b lg:border-b-0 lg:border-r divide-y max-h-[480px] overflow-y-auto"
                style={{ backgroundColor: 'var(--surface-subtle)', borderColor: 'var(--gray-6)' }}
              >
                {works.map((w) => {
                  const isActive = activeWork?.id === w.id
                  const st = WORK_STATUS_META[w.status] ?? { label: w.status, tone: 'neutral' as BadgeTone }
                  return (
                    <div
                      key={w.id}
                      className="flex items-center justify-between gap-2 px-4 py-3 transition-colors duration-150"
                      style={{ backgroundColor: isActive ? 'var(--accent-3)' : 'transparent' }}
                    >
                      <button
                        type="button"
                        onClick={() => setActiveWork(w)}
                        aria-current={isActive ? 'true' : undefined}
                        className="min-w-0 flex-1 text-left cursor-pointer space-y-0.5"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="text-[13px] font-semibold truncate"
                            style={{ color: isActive ? 'var(--accent-11)' : 'var(--gray-12)' }}
                          >
                            《{w.title}》
                          </span>
                          <span
                            className="text-[11px] px-1.5 py-0.25 rounded shrink-0"
                            style={{ backgroundColor: 'var(--gray-3)', color: 'var(--gray-11)' }}
                          >
                            {WORK_KIND_LABEL[w.kind] ?? w.kind}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono-num" style={{ color: 'var(--gray-11)' }}>
                          {w.createdAt.slice(0, 16)} · {st.label}
                        </div>
                      </button>

                      {w.hasAudio && (
                        <Button
                          variant={isActive && playing ? 'primary' : 'secondary'}
                          size="icon"
                          aria-label={isActive && playing ? `暂停《${w.title}》` : `播放《${w.title}》`}
                          onClick={() => togglePlay(w)}
                          className="rounded-full shrink-0"
                        >
                          {isActive && playing ? <Pause className="w-3.5 h-3.5" aria-hidden="true" /> : <Play className="w-3.5 h-3.5" aria-hidden="true" />}
                        </Button>
                      )}
                    </div>
                  )
                })}
              </aside>

              <article className="lg:col-span-8 p-6 max-h-[480px] overflow-y-auto">
                {activeWork ? (
                  <div className="max-w-[65ch] space-y-4">
                    <header className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b" style={{ borderColor: 'var(--gray-6)' }}>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <h3 className="text-[18px] font-semibold">《{activeWork.title}》</h3>
                          <Badge tone="neutral">{WORK_KIND_LABEL[activeWork.kind] ?? activeWork.kind}</Badge>
                        </div>
                        {activeWork.moodNote && (
                          <p className="text-[13px] font-voice" style={{ color: 'var(--gray-11)' }}>
                            {activeWork.moodNote}
                          </p>
                        )}
                      </div>
                      {activeWork.hasAudio && (
                        <Button variant="primary" size="sm" onClick={() => togglePlay(activeWork)}>
                          {playing ? <Pause className="w-3.5 h-3.5" aria-hidden="true" /> : <Play className="w-3.5 h-3.5" aria-hidden="true" />}
                          <span>{playing ? '暂停播放' : '播放歌声'}</span>
                        </Button>
                      )}
                    </header>
                    <pre className="font-voice text-[15px] leading-[1.85] whitespace-pre-wrap m-0" style={{ color: 'var(--gray-12)' }}>
                      {activeWork.content}
                    </pre>
                  </div>
                ) : (
                  <EmptyState icon={Music2} title="选择一件作品" description="从左侧选择任意作品即可阅读正文或播放音频。" />
                )}
              </article>
            </div>
          )}
        </section>
      )}

      {/* 2) 表情包图库（无障碍拖放上传 + 情绪筛选 + 防误删确认） */}
      {!showSkeleton && tab === 'stickers' && (
        <section className="ui-panel p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-[15px] font-semibold">表情包图库</h2>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--gray-11)' }}>
                上传图片后会自动识别适用情绪，聊天时按当下心情自然选用。
              </p>
            </div>
            <span className="font-mono-num text-[12px]" style={{ color: 'var(--gray-11)' }}>
              共 {stickers.length}&nbsp;张
            </span>
          </div>

          <Dropzone
            accept="image/png,image/jpeg,image/webp,image/gif"
            uploading={uploading}
            onFile={(f) => { void handleUploadSticker(f) }}
            title="拖拽表情包到此处，或点击上传（AI 自动打标）"
            hint="支持 PNG、JPEG、WebP、GIF 格式，上传后即时生效"
          />

          <div className="flex flex-wrap gap-1.5" role="group" aria-label="按情绪筛选表情包">
            {EMOTIONS.map((em) => (
              <FilterChip
                key={em}
                pressed={filterEmotion === em}
                onClick={() => setFilterEmotion(em)}
              >
                {EMOTION_LABEL[em] ?? em}
              </FilterChip>
            ))}
          </div>

          {shownStickers.length === 0 ? (
            <EmptyState
              icon={ImageIcon}
              title={filterEmotion === 'all' ? '图库还是空的' : '该情绪分类下还没有表情包'}
              description={
                filterEmotion === 'all'
                  ? '在上方拖入几张她常用的表情图，系统会自动识别情绪标签。'
                  : '可以切换到“全部”查看已有表情，或上传新的匹配表情。'
              }
              action={
                filterEmotion !== 'all' ? (
                  <Button variant="secondary" size="sm" onClick={() => setFilterEmotion('all')}>
                    显示全部表情
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3.5">
              {shownStickers.map((s) => (
                <figure
                  key={s.key}
                  className="rounded-[10px] border p-2.5 flex flex-col gap-2 m-0"
                  style={{ backgroundColor: 'var(--surface-subtle)', borderColor: 'var(--gray-6)' }}
                >
                  <div
                    className="aspect-square rounded-[6px] overflow-hidden flex items-center justify-center p-1"
                    style={{ backgroundColor: 'var(--surface)' }}
                  >
                    <img
                      src={`/api/bots/${encodeURIComponent(botId)}/stickers/${encodeURIComponent(s.key)}/file`}
                      alt={s.description || s.key}
                      width={160}
                      height={160}
                      loading="lazy"
                      className="w-full h-full object-contain"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {s.emotions.map((em) => (
                      <span
                        key={em}
                        className="text-[11px] px-1.5 py-0.5 rounded"
                        style={{ backgroundColor: 'var(--accent-3)', color: 'var(--accent-11)' }}
                      >
                        {EMOTION_LABEL[em] ?? em}
                      </span>
                    ))}
                  </div>
                  <figcaption className="flex items-center justify-between text-[11px] pt-1 border-t" style={{ borderColor: 'var(--gray-6)', color: 'var(--gray-11)' }}>
                    <span className="font-mono-num">用过 {s.uses ?? 0}&nbsp;次</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`删除表情包 ${s.key}`}
                      onClick={() => setDeleteStickerTarget(s)}
                      style={{ color: 'var(--danger-fg)' }}
                      className="min-w-[26px] min-h-[26px] p-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </Button>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 3) 语音试听（情绪动态控调） */}
      {!showSkeleton && tab === 'tts' && (
        <section className="ui-panel p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b" style={{ borderColor: 'var(--gray-6)' }}>
            <div>
              <h2 className="text-[15px] font-semibold">语音表达试听</h2>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--gray-11)' }}>
                对比不同情绪下的语速与语气指令；正式语音消息会根据当下情绪自动匹配。
              </p>
            </div>
            <Badge tone={hasTts ? 'ok' : 'warn'}>{hasTts ? 'TTS 已就绪' : '未配置 TTS'}</Badge>
          </div>

          <div className="space-y-2">
            <div className="text-[12px] font-medium" style={{ color: 'var(--gray-11)' }}>选择情绪预设</div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="语音情绪预设">
              {TTS_MOOD_PRESETS.map((m) => (
                <FilterChip
                  key={m.id}
                  pressed={ttsEmotion === m.id}
                  onClick={() => setTtsEmotion(m.id)}
                >
                  {m.label}
                </FilterChip>
              ))}
            </div>
          </div>

          <form onSubmit={(e) => { void runTtsPreview(e) }} className="space-y-4" noValidate>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2 space-y-1.5">
                <label htmlFor="tts-text" className="block text-[12px] font-medium" style={{ color: 'var(--gray-12)' }}>
                  试听文本
                </label>
                <input
                  ref={ttsInputRef}
                  id="tts-text"
                  type="text"
                  value={ttsText}
                  onChange={(e) => {
                    setTtsText(e.target.value)
                    if (ttsError) setTtsError('')
                  }}
                  placeholder="输入一句想让她念出来的话…"
                  aria-invalid={Boolean(ttsError)}
                  className="ui-input font-voice"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="tts-tone" className="block text-[12px] font-medium" style={{ color: 'var(--gray-12)' }}>
                  自定义语气（可选）
                </label>
                <input
                  id="tts-tone"
                  type="text"
                  value={ttsTone}
                  onChange={(e) => setTtsTone(e.target.value)}
                  placeholder="留空则按所选情绪…"
                  className="ui-input"
                />
              </div>
            </div>

            {ttsError && (
              <p role="alert" aria-live="polite" className="text-[12px]" style={{ color: 'var(--danger-fg)' }}>
                {ttsError}
              </p>
            )}

            <div className="flex items-center justify-end">
              <Button type="submit" variant="primary" loading={ttsLoading}>
                <Volume2 className="w-4 h-4" aria-hidden="true" />
                <span>{ttsLoading ? '正在合成语音…' : '试听语音'}</span>
              </Button>
            </div>
          </form>
        </section>
      )}

      <AlertDialog
        open={Boolean(deleteStickerTarget)}
        title="删除这张表情包？"
        description="删除后该图片会立即从表情包图库移除，聊天时将不再选用。"
        confirmLabel="删除表情包"
        destructive
        loading={deletingSticker}
        onCancel={() => setDeleteStickerTarget(null)}
        onConfirm={() => { void confirmDeleteSticker() }}
      />
    </div>
  )
}
