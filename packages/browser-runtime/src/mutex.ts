// Minimal async mutex for connection-level serialization.

export class AsyncMutex {
  private queue: Array<() => void> = []
  private locked = false

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true
      return this._release()
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(this._release()))
    })
  }

  private _release(): () => void {
    return () => {
      const next = this.queue.shift()
      if (next) {
        next()
      } else {
        this.locked = false
      }
    }
  }
}
