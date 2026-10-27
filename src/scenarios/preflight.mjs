// Read-only gate: everything worth knowing BEFORE a run, so a failure reads as
// "the API is down" or "dev still serves yesterday's build" up front instead of
// 20 minutes of red tests later.
// Never mutates anything -- prepare.mjs is the one that fixes what this finds.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { checkToolkit } from './toolkit.mjs'
import { FINTARY_DIR, FT_E2E_DIR, childPath } from '../ft-e2e.mjs'
import { knownEnv } from '../env.mjs'

// One monorepo holds the web app (services/web) and the API (services/api).
export const APP_REPOS = ['fintary']

const require = createRequire(import.meta.url)
const harnessConfig = () => require(path.join(FT_E2E_DIR, 'lib', 'config.cjs'))
const harnessFirebase = () => require(path.join(FT_E2E_DIR, 'lib', 'firebase.cjs'))
const join = (base, p) => new URL(p.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`).toString()

/** GET a URL; any HTTP answer counts as reachable. Returns the parsed JSON when there is some. */
async function probe (url, timeoutMs = 8000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    const text = await res.text().catch(() => '')
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { reachable: true, status: res.status, json }
  } catch (err) {
    return { reachable: false, error: err.cause?.code ?? err.message }
  }
}

function tcp (port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host })
    const end = ok => { s.destroy(); resolve(ok) }
    s.setTimeout(timeoutMs, () => end(false))
    s.on('connect', () => end(true))
    s.on('error', () => end(false))
  })
}

/**
 * Does this ticket need a signed-in user? Specs that do use `appTest`, the
 * signed-in `api` fixture, `apiFor(.., { auth: true })` or `asUser: true`
 * (harness/fixtures). `test` + `publicApi` need no login.
 */
export function ticketNeedsLogin (ticket) {
  if (!ticket) return null
  const dir = path.join(FT_E2E_DIR, 'tests', ticket)
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir, { recursive: true }).filter(f => /\.ts$/.test(f))
  return files.some((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf-8')
    if (/\bappTest\b|asUser:\s*true|auth:\s*true/.test(src)) return true
    // The signed-in `api` fixture, as destructured by a test: async ({ page, api }) => ...
    return [...src.matchAll(/async\s*\(\s*\{([^}]*)\}/g)].some(m => m[1].split(',').map(x => x.trim()).includes('api'))
  })
}

export function gitStamp (repo, ref = null) {
  const at = repo === 'fintary' ? FINTARY_DIR : path.join(path.dirname(FINTARY_DIR), repo)
  if (!fs.existsSync(at)) return `${repo}: not found at ${at}`
  try {
    const run = args => execFileSync('git', args, { cwd: at, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (ref) return `${repo}: ${ref} @ ${run(['rev-parse', '--short', ref])} (as of last fetch)`
    const dirty = run(['status', '--porcelain', '--', 'services', 'packages']) ? ' (uncommitted changes)' : ''
    return `${repo}: ${run(['rev-parse', '--abbrev-ref', 'HEAD'])} @ ${run(['rev-parse', '--short', 'HEAD'])}${dirty}`
  } catch (err) {
    return `${repo}: unreadable (${err.message.split('\n')[0]})`
  }
}

/** What is live on a deployed environment: the API image's commit and the web build time. */
export async function liveStamp (env) {
  const [health, manifest] = await Promise.all([probe(join(env.apiURL, '/api/healthcheck')), probe(join(env.webURL, '/manifest.json'))])
  return {
    health,
    manifest,
    apiCommit: health.json?.commitSha ?? null,
    webBuiltAt: manifest.json?.versionInfo?.buildTime ?? null,
  }
}

/** The fintary repo's own local safety preflight (prod-valued web env, :5432 database URLs). */
function repoLocalPreflight () {
  const script = path.join(FINTARY_DIR, 'SKILLS', 'run-app', 'scripts', 'preflight.mts')
  if (!fs.existsSync(script)) return null
  const [maj, min] = process.versions.node.split('.').map(Number)
  const flags = maj > 23 || (maj === 23 && min >= 6) ? [] : ['--experimental-strip-types']
  const r = spawnSync(process.execPath, [...flags, script, '--mode', 'local', '--root', FINTARY_DIR], {
    cwd: FINTARY_DIR, encoding: 'utf-8', timeout: 60_000, env: { ...process.env, PATH: childPath() },
  })
  try {
    const out = JSON.parse((r.stdout || '').trim().split('\n').filter(l => l.startsWith('{')).pop())
    const blocked = (out.checks ?? []).filter(c => c.ok === false || c.blocking).map(c => `${c.name ?? c.id}: ${c.detail ?? c.message ?? 'blocked'}`)
    return { ok: r.status === 0, blocked, warnings: out.warnings ?? [] }
  } catch {
    return { ok: r.status === 0, blocked: r.status === 0 ? [] : [(r.stderr || 'preflight.mts failed').split('\n').filter(Boolean).slice(-2).join(' | ')], warnings: [] }
  }
}

/**
 * @param {{ env?: string, ticket?: string }} opts
 * @returns {Promise<{ ok: boolean, canRun: boolean, env: string, wired: boolean, needsLogin: boolean|null, blocking: string[], checks: object[], stamps: string[] }>}
 */
export async function preflight ({ env: envName = 'dev', ticket } = {}) {
  const env = knownEnv(envName)
  const checks = []
  const add = (name, ok, detail, blocking = false) => checks.push({
    name, ok, detail, blocking: blocking && !ok,
  })

  if (!env) {
    return { ok: false, canRun: false, env: envName, wired: false, needsLogin: null, blocking: [`unknown environment "${envName}"`], checks: [], stamps: [] }
  }

  const harnessOk = fs.existsSync(path.join(FT_E2E_DIR, 'playwright.config.ts'))
  add('ft-e2e harness', harnessOk, FT_E2E_DIR, true)
  const depsOk = fs.existsSync(path.join(FT_E2E_DIR, 'node_modules', '@playwright', 'test'))
  add('harness dependencies', depsOk, depsOk ? 'node_modules present' : 'run npm install in the harness (or: prepare / install_toolkit)', true)
  add('environment wired for runs', env.wired, env.notes, false)

  // null = no ticket given (or no such folder): login need unknown, so never block on it.
  const needsLogin = ticketNeedsLogin(ticket)
  const loginBlocks = needsLogin === true

  // The app and the API, on every environment (preview and prod included: GET only).
  const web = await probe(join(env.webURL, '/sign-in'))
  add(`web app reachable (${env.webURL})`, web.reachable && web.status < 500,
    web.reachable ? `HTTP ${web.status}` : `${web.error}${env.name === 'local' ? ' -- dev_stack_up starts it' : ''}`, true)
  const live = await liveStamp(env)
  add(`API healthy (${env.apiURL}api/healthcheck)`, live.health.reachable && live.health.status === 200 && live.health.json?.status === 'ok',
    live.health.reachable ? `HTTP ${live.health.status}${live.apiCommit ? `, image from ${live.apiCommit.slice(0, 10)}` : ''}` : live.health.error, true)
  if (env.name !== 'local') {
    add('live web build', !!live.webBuiltAt,
      live.webBuiltAt ? `built ${live.webBuiltAt} -- a merged change is only here once its deploy ran after the merge` : 'manifest.json has no versionInfo.buildTime', false)
  }

  if (env.wired && harnessOk) {
    const cfg = harnessConfig()
    const resolved = cfg.envConfig(env.harnessEnv)
    const creds = cfg.credentials(resolved)
    const session = cfg.sessionInfo(resolved.authPath)
    let sessionWorks = false
    let sessionDetail = session.detail
    if (session.usable) {
      try { await harnessFirebase().idToken(resolved); sessionWorks = true } catch (err) { sessionDetail = `${session.detail}; ${err.message}` }
    }
    add('test user', !!creds,
      creds ? `${creds.kind === 'uid' ? `uid ${creds.uid}` : cfg.maskEmail(creds.email)} from ${creds.source}` : `no E2E_EMAIL / E2E_PASSWORD in harness/${env.envFile}${needsLogin ? '' : ' (only signed-in specs need them)'}`,
      loginBlocks && !sessionWorks)
    // A dead session with credentials on file is not a blocker: the fixtures sign in
    // again through the web's form the first time a spec needs it.
    add('cached session', sessionWorks,
      `${env.authFile}: ${sessionDetail}`
      + (!sessionWorks ? (creds ? ' -- signed in again automatically when a spec needs it' : '') : ''),
      loginBlocks && !sessionWorks && !creds)
    if (resolved.accountId) add('account', true, `opens on ${resolved.accountId} (E2E_ACCOUNT_ID)`, false)
  }

  if (env.name === 'local') {
    const pg = await tcp(5431)
    add('Postgres (docker local-psql :5431)', pg, pg ? 'accepting connections' : 'down -- dev_stack_up (scripts/agent/up.sh) starts it', true)
    if (await tcp(5432)) add('port :5432', false, 'something listens on :5432, the PRODUCTION database proxy. The stack must never use it; do not stop it yourself, and check the api only talks to :5431.', false)
    const resolved = env.wired && harnessOk ? harnessConfig().envConfig(env.harnessEnv) : null
    if (resolved?.emulator) {
      const auth = await tcp(4002)
      add('auth emulator :4002', auth, auth ? 'listening' : 'down -- dev_stack_up (scripts/agent/up.sh) starts it', true)
    }
    const repo = repoLocalPreflight()
    if (repo) {
      add('fintary local safety preflight (SKILLS/run-app)', repo.ok,
        repo.ok ? `passed${repo.warnings.length ? `; warnings: ${repo.warnings.slice(0, 2).join('; ')}` : ''}` : repo.blocked.slice(0, 3).join(' | '), true)
    }
  }

  if (ticket) {
    const dir = path.join(FT_E2E_DIR, 'tests', ticket)
    const exists = fs.existsSync(dir)
    add(`tests/${ticket}`, exists,
      exists ? `present${needsLogin ? ' (signed in)' : ' (no login)'}` : 'no such test folder -- create harness/tests/<ticket>/*.spec.ts (/ft-e2e:scenarios then /ft-e2e:spec)', true)
  }

  // Toolkit: never blocking here (run_e2e gates on exactly what a run needs),
  // but every preflight says what is missing for which feature and how to fix it.
  const tk = await checkToolkit().catch(() => null)
  const toolkit = tk ? {
    features: Object.fromEntries(Object.entries(tk.features).map(([f, v]) => [f, v.ready ? 'ready' : `missing: ${v.missing.join(', ')}`])),
    missing: tk.missing.map(m => ({ id: m.id, label: m.label, kind: m.kind, command: m.command })),
  } : null

  const blocking = checks.filter(c => c.blocking).map(c => `${c.name}: ${c.detail}`)
  const ok = blocking.length === 0
  const stamps = env.name === 'local'
    ? APP_REPOS.map(r => gitStamp(r))
    : [`live api image from ${live.apiCommit ? live.apiCommit.slice(0, 10) : 'unknown'}`, `live web built ${live.webBuiltAt ?? 'unknown'}`, ...(env.name === 'dev' ? [gitStamp('fintary', 'origin/main')] : [])]
  return {
    ok,
    // `ok` means "nothing I checked is broken"; `canRun` means "and a test run
    // is actually possible here". preview and prod can be perfectly healthy and
    // still never be somewhere this harness may run a suite.
    canRun: ok && env.wired,
    env: env.name,
    wired: env.wired,
    needsLogin,
    blocking,
    checks,
    stamps,
    toolkit,
  }
}
