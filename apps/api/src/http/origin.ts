/**
 * WebSockets are not covered by CORS: a page on another site could open /ws/* with the user's cookie.
 * Browsers always send Origin; it must match the Host the request came to, or be listed in RELAY_ALLOWED_ORIGINS.
 * No Origin means a non-browser client, which still needs a session cookie or a visitor token.
 */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed: string[]): boolean {
  if (!origin) return true
  if (allowed.includes(origin)) return true
  try {
    return !!host && new URL(origin).host === host
  } catch {
    return false
  }
}
