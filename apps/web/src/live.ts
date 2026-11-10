export type Live = { stop(): void; send(data: string): boolean }

const OPEN = 1

export function connectLive(path: string, onFrame: (frame: any) => void, onOpen?: () => void): Live {
  let ws: WebSocket | null = null
  let delay = 1000
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}${path}`)
    ws.onopen = () => { delay = 1000; onOpen?.() }
    ws.onmessage = (e) => { try { onFrame(JSON.parse(e.data)) } catch { /* ignore malformed frames */ } }
    ws.onclose = (e) => {
      if (stopped || e.code === 4401 || e.code === 4400) return
      timer = setTimeout(open, delay)
      delay = Math.min(delay * 2, 10_000)
    }
  }
  open()
  return {
    stop: () => { stopped = true; clearTimeout(timer); ws?.close() },
    send: (data) => {
      if (!ws || ws.readyState !== OPEN) return false
      ws.send(data)
      return true
    },
  }
}
