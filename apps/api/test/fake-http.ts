import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }
export type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void

/** A real HTTP server on 127.0.0.1 (random port); `handler` decides each response. Nothing leaves the machine. */
export async function fakeHttp(handler: Handler) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

/** A URL where nothing listens: requests fail with "connection refused". */
export async function deadUrl(): Promise<string> {
  const s = await fakeHttp(() => {})
  await s.close()
  return s.url
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}
