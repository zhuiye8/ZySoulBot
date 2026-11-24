import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Music2, Play, Pause, Image as ImageIcon, Upload, Trash2, Volume2, Sparkles } from 'lucide-react'
import { api } from '../lib/api.ts'
import type { StickerItem, WorkItem } from '../lib/api.ts'

const EMOTIONS = ['all', 'praised', 'affection', 'humor', 'curiosity', 'annoyed', 'hurt', 'sadness', 'uneasy', 'boredom', 'rejected', 'conflict', 'neutral'] as const

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
  const [works, setWorks] = useState<WorkItem[]>([])
  const [hasSinging, setHasSinging] = useState(false)
  const [hasTts, setHasTts] = useState(false)
  const [activeWork, setActiveWork] = useState<WorkItem | null>(null)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const [stickers, setStickers] = useState<StickerItem[]>([])
  const [filterEmotion, setFilterEmotion] = useState<string>('all')
  const [uploading, setUploading] = useState(false)

  const [ttsText, setTtsText] = useState('你好呀，今天过得怎么样？')
  const [ttsLoading, setTtsLoading] = useState(false)

  useEffect(() => {
    setTab(validTab)
  }, [validTab])

  const switchTab = (next: WorksTab) => {
    setTab(next)
    onTabChange?.(next)
  }

  const loadAll = async () => {
    try {
      const [w, s] = await Promise.all([api.works(botId), api.stickers(botId)])
      setWorks(w.works)
      setHasSinging(w.hasSinging)
      setHasTts(w.hasTts)
      setActiveWork((prev) => prev ?? w.works[0] ?? null)
      setStickers(s.items)
    } catch (e) {
      toast.error((e as Error).message)
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
      toast.success(`上传成功，已自动打标：${res.sticker.emotions.join(', ')}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const handleDeleteSticker = async (key: string) => {
    try {
      await api.deleteSticker(botId, key)
      setStickers((prev) => prev.filter((s) => s.key !== key))
      toast.success('已删除表情包')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const runTtsPreview = async () => {
    if (!ttsText.trim()) return
    setTtsLoading(true)
    try {
      const blob = await api.ttsPreviewBlob(botId, ttsText)
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.onended = () => URL.revokeObjectURL(url)
      await audio.play()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setTtsLoading(false)
    }
  }

  const shownStickers = filterEmotion === 'all'
    ? stickers
    : stickers.filter((s) => s.emotions.includes(filterEmotion))

  return (
    <div className="space-y-5">
      <audio ref={audioRef} onEnded={() => setPlaying(false)} className="hidden" />

      <div className="flex flex-wrap gap-2">
        {[
          { id: 'songs' as const, label: '歌单与作品', icon: Music2, count: works.length },
          { id: 'stickers' as const, label: '表情包图库', icon: ImageIcon, count: stickers.length },
          { id: 'tts' as const, label: '语音试听', icon: Volume2, count: null },
        ].map((t) => {
          const Icon = t.icon
          const active = tab === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => switchTab(t.id)}
              className={`acg-btn ${active ? 'acg-btn-primary' : 'acg-btn-soft'}`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
              {t.count !== null && <span className="text-xs opacity-80 font-mono-num">({t.count})</span>}
            </button>
          )
        })}
      </div>

      {/* 1) 歌单与作品播放器（Mureka 唱歌） */}
      {tab === 'songs' && (
      <section className="acg-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold flex items-center gap-2">
            <Music2 className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            她的歌单与作品
          </h3>
          <span className="acg-pill text-[11px]">
            <Sparkles className="w-3 h-3" style={{ color: hasSinging ? 'var(--ok)' : 'var(--text-2)' }} />
            {hasSinging ? 'Mureka 唱歌已接入' : '未配置 Mureka（配置后她就能自己填词唱歌）'}
          </span>
        </div>

        {works.length === 0 ? (
          <p className="text-sm font-voice py-8 text-center" style={{ color: 'var(--text-2)' }}>
            歌单还是空的，等她哪天兴起或你点一首歌，作品就会收在这里。
          </p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <div className="lg:col-span-2 space-y-2 max-h-[340px] overflow-y-auto pr-1">
              {works.map((w) => {
                const isActive = activeWork?.id === w.id
                return (
                  <div
                    key={w.id}
                    onClick={() => setActiveWork(w)}
                    className="p-3 rounded-xl border flex items-center justify-between gap-3 cursor-pointer"
                    style={{
                      backgroundColor: isActive ? 'var(--accent-soft)' : 'var(--surface-2)',
                      borderColor: isActive ? 'var(--accent)' : 'var(--border)',
                    }}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">《{w.title}》</div>
                      <div className="text-[11px] font-mono-num" style={{ color: 'var(--text-2)' }}>
                        {w.createdAt.slice(0, 16)} · {w.status === 'ready' ? '已录好' : w.status === 'generating' ? '哼唱录制中...' : w.status}
                      </div>
                    </div>
                    {w.hasAudio && (
                      <button
                        type="button"
                        aria-label={isActive && playing ? '暂停' : '播放'}
                        onClick={(e) => {
                          e.stopPropagation()
                          togglePlay(w)
                        }}
                        className="acg-btn acg-btn-primary p-2 rounded-full shrink-0"
                      >
                        {isActive && playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>

            {activeWork && (
              <div
                className="lg:col-span-3 p-5 rounded-2xl border space-y-3"
                style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h4 className="text-base font-bold">《{activeWork.title}》</h4>
                    {activeWork.moodNote && (
                      <p className="text-xs font-voice mt-0.5" style={{ color: 'var(--text-2)' }}>
                        {activeWork.moodNote}
                      </p>
                    )}
                  </div>
                  {activeWork.hasAudio && (
                    <button type="button" onClick={() => togglePlay(activeWork)} className="acg-btn acg-btn-primary text-xs">
                      {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                      {playing ? '暂停' : '播放歌声'}
                    </button>
                  )}
                </div>
                <pre className="font-voice text-[14px] leading-[1.85] whitespace-pre-wrap m-0 max-h-[240px] overflow-y-auto">
                  {activeWork.content}
                </pre>
              </div>
            )}
          </div>
        )}
      </section>
      )}

      {/* 2) 语音试听（TTS） */}
      {tab === 'tts' && (
      <section className="acg-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-semibold flex items-center gap-2">
            <Volume2 className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            语音表达试听（TTS）
          </h3>
          <span className="acg-pill text-[11px]">{hasTts ? 'TTS 已就绪' : '未配置 TTS'}</span>
        </div>
        <div className="flex flex-col sm:flex-row gap-2.5">
          <input
            type="text"
            value={ttsText}
            onChange={(e) => setTtsText(e.target.value)}
            placeholder="输入一句想让她念出来的话..."
            className="acg-input flex-1 font-voice"
          />
          <button
            type="button"
            disabled={!hasTts || ttsLoading}
            onClick={() => { void runTtsPreview() }}
            className="acg-btn acg-btn-primary shrink-0 disabled:opacity-50"
          >
            <Volume2 className="w-4 h-4" />
            {ttsLoading ? '合成中...' : '试听一句'}
          </button>
        </div>
      </section>
      )}

      {/* 3) 表情包图库 */}
      {tab === 'stickers' && (
      <section className="acg-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-[15px] font-semibold flex items-center gap-2">
            <ImageIcon className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            表情包图库（{stickers.length}）
          </h3>
          <label className="acg-btn acg-btn-primary text-xs cursor-pointer">
            <Upload className="w-3.5 h-3.5" />
            {uploading ? '上传并自动打标...' : '上传表情包（AI 自动打标）'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleUploadSticker(f)
                e.target.value = ''
              }}
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {EMOTIONS.map((em) => (
            <button
              key={em}
              type="button"
              onClick={() => setFilterEmotion(em)}
              className={`acg-pill cursor-pointer ${filterEmotion === em ? 'font-semibold' : ''}`}
              style={{
                backgroundColor: filterEmotion === em ? 'var(--accent-soft)' : 'var(--surface-2)',
                color: filterEmotion === em ? 'var(--accent)' : 'var(--text-2)',
              }}
            >
              {em === 'all' ? '全部' : em}
            </button>
          ))}
        </div>

        {shownStickers.length === 0 ? (
          <p className="text-sm font-voice py-8 text-center" style={{ color: 'var(--text-2)' }}>
            这里还没有表情包，点右上角上传几张她会喜欢的图吧。
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {shownStickers.map((s) => (
              <div
                key={s.key}
                className="p-2.5 rounded-xl border flex flex-col gap-2"
                style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}
              >
                <div className="aspect-square rounded-lg overflow-hidden flex items-center justify-center" style={{ backgroundColor: 'var(--surface)' }}>
                  <img
                    src={`/api/bots/${encodeURIComponent(botId)}/stickers/${encodeURIComponent(s.key)}/file`}
                    alt={s.description || s.key}
                    loading="lazy"
                    className="w-full h-full object-contain"
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  {s.emotions.map((e) => (
                    <span key={e} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: 'var(--accent-soft)', color: 'var(--accent)' }}>
                      {e}
                    </span>
                  ))}
                </div>
                <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--text-2)' }}>
                  <span className="font-mono-num">用过 {s.uses ?? 0} 次</span>
                  <button
                    type="button"
                    aria-label="删除表情包"
                    onClick={() => { void handleDeleteSticker(s.key) }}
                    className="p-1 cursor-pointer"
                    style={{ color: 'var(--danger)' }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      )}
    </div>
  )
}
