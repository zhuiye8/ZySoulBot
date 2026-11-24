// 消息合批防抖器：连发合并成一次回合 + 最长等待硬上限 + 群聊动态延长（话没说完再等一轮）。
export interface BatcherOptions<T> {
  quietMs: number
  maxWaitMs: number
  extendMs?: number
  maxExtensions?: number
  shouldWait?: (key: string, items: T[]) => Promise<boolean>
  onFlush: (key: string, items: T[]) => void
}

interface Bucket<T> {
  items: T[]
  firstAt: number
  extensions: number
  quietTimer: ReturnType<typeof setTimeout> | null
  maxTimer: ReturnType<typeof setTimeout> | null
  checking: boolean
}

export class MessageBatcher<T> {
  private buckets = new Map<string, Bucket<T>>()
  private opts: BatcherOptions<T>
  private disposed = false

  constructor(opts: BatcherOptions<T>) {
    this.opts = opts
  }

  push(key: string, item: T): void {
    if (this.disposed) return
    if (this.opts.quietMs <= 0) {
      this.opts.onFlush(key, [item])
      return
    }
    let b = this.buckets.get(key)
    if (!b) {
      b = { items: [], firstAt: Date.now(), extensions: 0, quietTimer: null, maxTimer: null, checking: false }
      this.buckets.set(key, b)
      b.maxTimer = setTimeout(() => { this.flush(key) }, this.opts.maxWaitMs)
      b.maxTimer.unref?.()
    }
    b.items.push(item)
    if (b.quietTimer) clearTimeout(b.quietTimer)
    b.quietTimer = setTimeout(() => { void this.onQuiet(key) }, this.opts.quietMs)
    b.quietTimer.unref?.()
  }

  private async onQuiet(key: string): Promise<void> {
    const b = this.buckets.get(key)
    if (!b || b.checking) return
    const maxExt = this.opts.maxExtensions ?? 0
    if (this.opts.shouldWait && b.extensions < maxExt && Date.now() - b.firstAt < this.opts.maxWaitMs) {
      b.checking = true
      let wait = false
      try {
        wait = await this.opts.shouldWait(key, [...b.items])
      } catch {
        wait = false
      }
      const cur = this.buckets.get(key)
      if (!cur || cur !== b) return
      b.checking = false
      if (wait) {
        b.extensions += 1
        const remaining = Math.max(100, this.opts.maxWaitMs - (Date.now() - b.firstAt))
        const delay = Math.min(this.opts.extendMs ?? this.opts.quietMs, remaining)
        b.quietTimer = setTimeout(() => { void this.onQuiet(key) }, delay)
        b.quietTimer.unref?.()
        return
      }
    }
    this.flush(key)
  }

  flush(key: string): void {
    const b = this.buckets.get(key)
    if (!b) return
    this.buckets.delete(key)
    if (b.quietTimer) clearTimeout(b.quietTimer)
    if (b.maxTimer) clearTimeout(b.maxTimer)
    if (b.items.length > 0) this.opts.onFlush(key, b.items)
  }

  dispose(): void {
    this.disposed = true
    for (const b of this.buckets.values()) {
      if (b.quietTimer) clearTimeout(b.quietTimer)
      if (b.maxTimer) clearTimeout(b.maxTimer)
    }
    this.buckets.clear()
  }
}
