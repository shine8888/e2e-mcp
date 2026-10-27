// API evidence. Every call made through the `api` (Fintary API, signed in),
// `publicApi` (no auth) or `apiFor(baseURL)` fixtures is recorded per test and
// attached as `api-calls`: method, path, status, timing, request and response
// bodies, the backend request id and a replayable curl line.
//
// Cleaned when it is recorded, so nothing downstream ever sees raw data:
//   - secrets ALWAYS redacted: passwords, tokens, authentication/Authorization, card number/CVC,
//     API keys, and anything that looks like a JWT
//   - emails / phone numbers masked and bodies truncated, unless E2E_API_FULL=1
//     (local debugging only -- such runs are flagged and must not be shared)
// Paths are relative to the fixture's base URL: api.get('api/healthcheck'), api.get('api/policies?limit=5')
// -- no leading slash.
import type { APIRequestContext, APIResponse } from '@playwright/test'

export const FULL = process.env.E2E_API_FULL === '1'
const MAX_BODY = 2000
const SECRET_KEY = /pass(word)?|secret|token|authori[sz]ation|authenticat|api[-_]?key|cardnumber|card_number|cvv|cvc|securitycode|refresh/i
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g
// Only +international numbers in free text (bare digit runs are dates, ids, prices);
// fields named phone/mobile/tel are masked whatever their format.
const PHONE = /(?<![\w.])\+\d[\d\s()-]{7,}\d(?![\w.])/g
const PHONE_KEY = /phone|mobile|^tel/i

function cleanString (s: string) {
  let out = s.replace(JWT, '[redacted]')
  if (!FULL) out = out.replace(EMAIL, '$1***@$2').replace(PHONE, m => `${m.slice(0, 3)}***`)
  return out
}

export function clean (value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return cleanString(value)
  if (typeof value !== 'object' || depth > 12) return value
  if (Array.isArray(value)) return value.map(v => clean(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k) && v !== null && typeof v !== 'object') out[k] = '[redacted]'
    else if (!FULL && PHONE_KEY.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length > 3) out[k] = `${String(v).slice(0, 3)}***`
    else out[k] = clean(v, depth + 1)
  }
  return out
}

function truncate (body: unknown) {
  if (FULL || body === undefined || body === null) return body
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}… [${text.length - MAX_BODY} more chars]` : body
}

export type ApiCall = {
  n: number, method: string, path: string, url: string, status: number | null, ms: number,
  requestBody?: unknown, responseBody?: unknown, requestId?: string | null, curl: string, error?: string
}

function pathOf (url: string) {
  try {
    const u = new URL(url)
    for (const k of [...u.searchParams.keys()]) if (SECRET_KEY.test(k)) u.searchParams.set(k, '[redacted]')
    return cleanString(u.pathname + u.search)
  } catch { return url }
}

type Opts = Parameters<APIRequestContext['fetch']>[1]

/** Wraps a Playwright APIRequestContext so every call lands in `log`. Returns the real APIResponse. */
export function recordingClient (ctx: APIRequestContext, baseURL: string, log: ApiCall[], authHeaderName?: string, curlHeaders: Record<string, string> = {}) {
  const call = async (method: string, url: string, options: Opts = {}): Promise<APIResponse> => {
    const abs = new URL(url, baseURL).toString()
    const started = Date.now()
    const n = log.length + 1
    const reqBody = (options as any)?.data ?? (options as any)?.form ?? (options as any)?.multipart
    const curlParts = [`curl -sS -X ${method}`, `'${abs.replace(/'/g, "'\\''")}'`]
    if (authHeaderName) curlParts.push(`-H "${authHeaderName}: Bearer $FT_ID_TOKEN"`)
    // Non-secret headers the API needs to answer (accountid), so the curl line replays as is.
    for (const [k, v] of Object.entries(curlHeaders)) curlParts.push(`-H '${k}: ${String(v).replace(/'/g, '')}'`)
    if (reqBody !== undefined) curlParts.push(`-H 'Content-Type: application/json' --data '${JSON.stringify(clean(reqBody)).replace(/'/g, "'\\''")}'`)
    const rec: ApiCall = {
      n, method, path: pathOf(abs), url: cleanString(abs), status: null, ms: 0,
      requestBody: truncate(clean(reqBody)), curl: curlParts.join(' '),
    }
    log.push(rec)
    try {
      const res = await ctx.fetch(abs, { ...options, method })
      rec.status = res.status()
      rec.ms = Date.now() - started
      const h = res.headers()
      rec.requestId = h['trace-id'] ?? h['x-trace-id'] ?? h['x-cloud-trace-context'] ?? h['x-request-id'] ?? null
      const text = await res.text().catch(() => '')
      let body: unknown = text
      try { body = JSON.parse(text) } catch { /* not JSON */ }
      rec.responseBody = truncate(clean(body))
      return res
    } catch (err: any) {
      rec.ms = Date.now() - started
      rec.error = String(err?.message ?? err).split('\n')[0]
      throw err
    }
  }
  return {
    fetch: (url: string, o?: Opts) => call(((o as any)?.method ?? 'GET').toUpperCase(), url, o),
    get: (url: string, o?: Opts) => call('GET', url, o),
    post: (url: string, o?: Opts) => call('POST', url, o),
    put: (url: string, o?: Opts) => call('PUT', url, o),
    patch: (url: string, o?: Opts) => call('PATCH', url, o),
    delete: (url: string, o?: Opts) => call('DELETE', url, o),
    head: (url: string, o?: Opts) => call('HEAD', url, o),
    baseURL,
  }
}

export type RecordingClient = ReturnType<typeof recordingClient>
