// 按键串行队列：单 bot 单写者模型，彻底消除回合与后台节律的状态竞态。
export class SerialQueue {
  private chains = new Map<string, Promise<unknown>>()
  private active = new Map<string, number>()

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    this.active.set(key, (this.active.get(key) ?? 0) + 1)
    const next = prev.then(task, task).finally(() => {
      const n = (this.active.get(key) ?? 1) - 1
      if (n <= 0) {
        this.active.delete(key)
        if (this.chains.get(key) === next) this.chains.delete(key)
      } else {
        this.active.set(key, n)
      }
    })
    this.chains.set(key, next)
    return next
  }

  busy(key: string): boolean {
    return (this.active.get(key) ?? 0) > 0
  }
}
