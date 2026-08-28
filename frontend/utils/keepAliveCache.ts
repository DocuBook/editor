/** Generic lazy cache used by the editor keep-alive boundary. */
export class KeepAliveCache<T> {
  private entries = new Map<string, T>()
  private readonly create: (key: string) => T
  constructor(create: (key: string) => T) { this.create = create }
  get(key: string): T {
    if (!this.entries.has(key)) this.entries.set(key, this.create(key))
    return this.entries.get(key)!
  }
  clear() { this.entries.clear() }
}
