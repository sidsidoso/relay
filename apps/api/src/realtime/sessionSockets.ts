import type { WebSocket } from 'ws'

/** Open inbox sockets by session token, so signing out closes them at once. */
export class SessionSockets {
  private byToken = new Map<string, Set<WebSocket>>()

  add(token: string, socket: WebSocket): () => void {
    const set = this.byToken.get(token) ?? new Set<WebSocket>()
    set.add(socket)
    this.byToken.set(token, set)
    return () => {
      set.delete(socket)
      if (set.size === 0) this.byToken.delete(token)
    }
  }

  closeAll(token: string): void {
    for (const socket of [...(this.byToken.get(token) ?? [])]) socket.close(4401, 'unauthenticated')
    this.byToken.delete(token)
  }
}
