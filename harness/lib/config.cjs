// Shared harness config, in CommonJS on purpose: playwright.config.ts and the
// fixtures (transpiled to CJS by Playwright) require() it, and the .mjs scripts
// import it -- one implementation for both, under any Node 18+.
//
// The environment LIST is not here: it is ../config/environments.json, the same
// file the MCP server reads (FT_E2E_ENVIRONMENTS overrides the path when the
// harness is used on its own).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HARNESS_DIR = path.resolve(__dirname, '..')
const REGISTRY = process.env.FT_E2E_ENVIRONMENTS || path.resolve(HARNESS_DIR, '..', 'config', 'environments.json')

const isFintary = d => fs.existsSync(path.join(d, 'pnpm-workspace.yaml')) && fs.existsSync(path.join(d, 'services', 'web', 'package.json'))

/** The fintary monorepo under test (git stamps, the local stack, its sign-in scripts). */
const FINTARY_DIR = process.env.FINTARY_DIR
  || [path.resolve(__dirname, '../../..', 'fintary'), path.join(os.homedir(), 'Documents/WorkSpaces/FINTARY/fintary')].find(isFintary)
  || path.resolve(__dirname, '../../..', 'fintary')

function registry () {
  return JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'))
}

/**
 * Minimal dotenv: KEY=VALUE lines, optional quotes, `#` comments. Lines without
 * `=` are ignored rather than guessed at.
 */
function readEnvFile (file) {
  const out = {}
  if (!file || !fs.existsSync(file)) return out
  for (const raw of fs.readFileSync(file, 'utf-8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

/**
 * The environment record for ENV=<name>, with the harness env file and process
 * env layered over the registry. Overridable per run without editing JSON:
 * E2E_WEB_URL, E2E_API_URL, E2E_ACCOUNT_ID.
 */
function envConfig (name = process.env.ENV || registry().default) {
  const rec = registry().environments.find(e => e.harnessEnv === name || e.name === name)
  if (!rec) throw new Error(`Unknown ENV "${name}". Known: ${registry().environments.map(e => e.name).join(', ')}`)
  if (!rec.wired) throw new Error(`ENV "${name}" is declared but not wired for test runs: ${rec.notes}`)
  const file = readEnvFile(path.join(HARNESS_DIR, rec.envFile))
  const pick = (k, fallback) => process.env[k] || file[k] || fallback
  return {
    ...rec,
    webURL: pick('E2E_WEB_URL', rec.webURL),
    apiURL: pick('E2E_API_URL', rec.apiURL),
    accountId: pick('E2E_ACCOUNT_ID', rec.accountId),
    emulator: rec.name === 'local' && pick('E2E_EMULATOR', '') === '1',
    authPath: path.join(HARNESS_DIR, rec.authFile),
    envFilePath: path.join(HARNESS_DIR, rec.envFile),
  }
}

/** Hosts whose writes every test context aborts (preview and prod share production data). */
function writeGuardHosts () {
  return registry().writeGuardHosts ?? []
}

/**
 * Test-user credentials: E2E_EMAIL / E2E_PASSWORD (password sign-in through the
 * web's own form), or E2E_UID (local only: the repo's custom-token scripts),
 * from the process env, else from the environment's own file (harness/.env.dev,
 * .env.uat, .env.local). Never read from the fintary repo's env files: tracked
 * ones hold live secrets, and the app repo's production env files point at production.
 */
function credentials (env) {
  const file = readEnvFile(env.envFilePath)
  const get = k => process.env[k] || file[k]
  const source = k => (process.env[k] ? 'process env' : path.basename(env.envFilePath))
  if (get('E2E_EMAIL') && get('E2E_PASSWORD')) return { kind: 'password', email: get('E2E_EMAIL'), password: get('E2E_PASSWORD'), source: source('E2E_EMAIL') }
  if (env.name === 'local' && get('E2E_UID')) return { kind: 'uid', uid: get('E2E_UID'), email: get('E2E_EMAIL') || '', source: source('E2E_UID') }
  return null
}

const maskEmail = e => (e ? e.replace(/^(.).*?(@.*)$/, '$1***$2') : e)

function decodeJwt (token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf-8')) } catch { return null }
}

/** The Firebase user record the web keeps in IndexedDB (firebaseLocalStorageDb), wherever it sits in a storageState. */
// Playwright >= 1.5x stores IndexedDB records as `valueEncoded` (its own serialized
// form: {o:[{k,v}]} objects, {a:[...]} arrays, {v:'undefined'|'null'|...} specials)
// instead of a plain `value`. Decode it back to a plain value.
function decodePw (v, refs = new Map()) {
  if (v === null || typeof v !== 'object') return v
  if ('ref' in v) return refs.get(v.ref)
  if ('v' in v) return { undefined: undefined, null: null, NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 }[v.v]
  if ('d' in v) return new Date(v.d).getTime()
  if ('u' in v) return v.u
  if ('bi' in v) return v.bi
  if (Array.isArray(v.a)) { const out = []; refs.set(v.id, out); for (const x of v.a) out.push(decodePw(x, refs)); return out }
  if (Array.isArray(v.o)) { const out = {}; refs.set(v.id, out); for (const { k, v: x } of v.o) out[k] = decodePw(x, refs); return out }
  return v
}

function findAuthUser (node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null
  if (node.valueEncoded && node.value === undefined) {
    const hit = findAuthUser(decodePw(node.valueEncoded), depth + 1)
    if (hit) return hit
  }
  if (typeof node.fbase_key === 'string' && node.fbase_key.startsWith('firebase:authUser:') && node.value) return node.value
  if (typeof node.key === 'string' && node.key.startsWith('firebase:authUser:') && node.value && typeof node.value === 'object') {
    return node.value.value ?? node.value
  }
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const hit = findAuthUser(v, depth + 1)
    if (hit) return hit
  }
  return null
}

/**
 * What a cached storageState holds: the Firebase user (uid, email, apiKey) and its
 * tokens. `usable` = a refresh token is there (the web refreshes the ID token itself,
 * and lib/firebase.cjs refreshes it for API calls); whether it still WORKS is only
 * known by trying, which firebase.cjs does.
 */
function sessionInfo (authPath) {
  if (!fs.existsSync(authPath)) return { present: false, usable: false, detail: 'no cached session file' }
  try {
    const state = JSON.parse(fs.readFileSync(authPath, 'utf-8'))
    const user = findAuthUser(state.origins ?? [])
    if (!user) return { present: true, usable: false, detail: 'no Firebase user in the cached state (IndexedDB missing?)' }
    const stm = user.stsTokenManager ?? {}
    const msLeft = (stm.expirationTime ?? 0) - Date.now()
    const ageH = (Date.now() - fs.statSync(authPath).mtimeMs) / 3_600_000
    return {
      present: true,
      usable: !!stm.refreshToken,
      uid: user.uid,
      email: maskEmail(user.email),
      apiKey: user.apiKey,
      accessToken: stm.accessToken,
      refreshToken: stm.refreshToken,
      msLeft,
      ageHours: Math.round(ageH * 10) / 10,
      detail: `${maskEmail(user.email) ?? user.uid}, saved ${Math.round(ageH)} h ago, ID token ${msLeft > 0 ? `valid ${Math.round(msLeft / 60_000)} more min` : 'expired (the web refreshes it)'}`,
    }
  } catch (err) {
    return { present: true, usable: false, detail: `unreadable: ${err.message}` }
  }
}

/** Run ids name a run's folder: tickets/<T>/<evidenceDir>/runs/<YYYY-MM-DD_HH-MM-SS>. */
function newRunId (d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

function evidenceRoot (ticket, env) {
  return path.join(HARNESS_DIR, 'tickets', ticket, env.evidenceDir)
}

function runDir (ticket, env, runId) {
  return path.join(evidenceRoot(ticket, env), 'runs', runId)
}

/** A web-app URL: webUrl(env, '/policies?status=active'). The app is a BrowserRouter app with flat paths. */
function webUrl (env, route = '/') {
  return new URL(String(route).replace(/^\//, ''), env.webURL.endsWith('/') ? env.webURL : `${env.webURL}/`).toString()
}

module.exports = {
  HARNESS_DIR, FINTARY_DIR, REGISTRY, registry, readEnvFile, envConfig, writeGuardHosts, credentials, maskEmail,
  decodeJwt, findAuthUser, sessionInfo, newRunId, evidenceRoot, runDir, webUrl,
}
