// The toolkit doctor: what each feature needs on this machine, what is
// missing, and how to get it.
//
//   checkToolkit({ features })   read-only. One row per requirement with ok,
//                                detail and a fix: { kind: 'auto' | 'manual', command }.
//   installToolkit({ items })    runs the 'auto' fixes for the ids given and
//                                re-checks. Never runs a 'manual' one.
//
// 'auto' = safe for this server to run: no admin password, no secret, nothing
// outside the user's own caches and checkouts (npm install from package.json,
// Playwright browser downloads into ~/Library/Caches/ms-playwright, Homebrew).
// 'manual' = needs an admin password (Edge .pkg installer), a secret (the Linear
// API key, the test user's password), a machine-level app (Docker Desktop)
// or the repo's first-time setup (scripts/agent/setup.sh). Those come back as the exact command to run.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { childPath, MCP_DIR, FINTARY_DIR, FT_E2E_DIR, runInHarness } from '../ft-e2e.mjs'

/** Which requirement ids each feature needs. */
export const FEATURES = {
  core: ['node', 'harness-checkout', 'harness-deps', 'mcp-deps', 'pw-chromium', 'pw-ffmpeg'],
  // Signed-in specs (appTest / api) per environment: the test user in harness/.env.<env>.
  dev: ['env-dev'],
  uat: ['env-uat'],
  // The local Fintary stack (dev_stack_up / prepare on env=local, scripts/agent/up.sh).
  local: ['fintary-checkout', 'node-repo', 'pnpm', 'docker', 'env-local'],
  // pw-ffmpeg records each test's video; system ffmpeg stitches the reel.
  demo: ['pw-ffmpeg', 'ffmpeg', 'ffmpeg-libvpx', 'ffprobe'],
  devices: [],
  browsers: ['pw-firefox', 'pw-webkit', 'chrome', 'edge'],
  publish: ['ffmpeg-libx264', 'linear-key'],
}
export const FEATURE_NAMES = Object.keys(FEATURES)
// Missing these does not stop the feature: the other browsers still run.
const OPTIONAL = new Set(['chrome', 'edge'])

const has = (cmd) => {
  try { execFileSync('which', [cmd], { env: { ...process.env, PATH: childPath() }, stdio: ['ignore', 'pipe', 'ignore'] }); return true } catch { return false }
}
const out = (cmd, args) => {
  try { return execFileSync(cmd, args, { env: { ...process.env, PATH: childPath() }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }).toString() } catch { return '' }
}

/** Playwright's own idea of where its browsers should be, from the harness's installed version. */
async function playwrightPaths () {
  const script = `
    const pw = require('@playwright/test');
    const fs = require('fs');
    const path = require('path');
    const v = require('@playwright/test/package.json').version;
    const p = n => { try { const e = pw[n].executablePath(); return { path: e, exists: fs.existsSync(e) } } catch (err) { return { path: null, exists: false, error: String(err.message).split(String.fromCharCode(10))[0] } } };
    // Playwright's own ffmpeg (records each test's video) is not exposed by the
    // public API; its revision is in playwright-core's browsers.json.
    let ffmpeg = { path: null, exists: false, error: 'unknown' };
    try {
      const bj = JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve('playwright-core')), 'browsers.json'), 'utf8'));
      const rev = (bj.browsers.find(b => b.name === 'ffmpeg') || {}).revision;
      const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(require('os').homedir(), 'Library/Caches/ms-playwright');
      const ff = rev ? path.join(cache, 'ffmpeg-' + rev) : null;
      ffmpeg = { path: ff, exists: !!ff && fs.existsSync(ff) };
    } catch (err) { ffmpeg.error = String(err.message).split(String.fromCharCode(10))[0] }
    console.log(JSON.stringify({ version: v, chromium: p('chromium'), firefox: p('firefox'), webkit: p('webkit'), ffmpeg }))`
  const r = await runInHarness('node', ['-e', script], { timeoutMs: 30_000 }).catch(err => ({ stdout: '', stderr: err.message }))
  try { return JSON.parse(r?.stdout?.trim().split('\n').at(-1) ?? '') } catch {
    return { probeError: (r?.stderr || 'no output').trim().split('\n').find(l => /Error/.test(l)) ?? 'probe failed' }
  }
}

export async function checkToolkit ({ features } = {}) {
  const want = features?.length ? features : FEATURE_NAMES
  const ids = new Set(['core', ...want].flatMap(f => FEATURES[f] ?? []))
  const rows = []
  const add = (id, label, ok, detail, fix) => { if (ids.has(id)) rows.push({ id, label, ok, detail, fix: ok === false ? fix : null }) }

  const nodeMajor = Number(process.versions.node.split('.')[0])
  add('node', 'Node.js 18+ for this server', nodeMajor >= 18, `v${process.versions.node} at ${process.execPath}`,
    { kind: 'manual', command: 'nvm install 22 && nvm use 22, then re-register the MCP with that node\'s absolute path' })

  const checkout = fs.existsSync(path.join(FT_E2E_DIR, 'playwright.config.ts'))
  add('harness-checkout', 'ft-e2e harness', checkout, FT_E2E_DIR,
    { kind: 'manual', command: `Set FT_E2E_DIR to the harness folder (looked in ${FT_E2E_DIR})` })
  add('harness-deps', 'Harness dependencies (Playwright 1.60)', fs.existsSync(path.join(FT_E2E_DIR, 'node_modules', '@playwright', 'test')),
    path.join(FT_E2E_DIR, 'node_modules'), { kind: 'auto', command: `cd ${FT_E2E_DIR} && npm install --no-audit --no-fund` })
  add('mcp-deps', 'ft-e2e-mcp dependencies', fs.existsSync(path.join(MCP_DIR, 'node_modules', '@modelcontextprotocol', 'sdk')),
    path.join(MCP_DIR, 'node_modules'), { kind: 'auto', command: `cd ${MCP_DIR} && npm install --no-audit --no-fund` })

  add('chrome', 'Google Chrome (browsers: chrome)', fs.existsSync('/Applications/Google Chrome.app'), '/Applications/Google Chrome.app',
    { kind: 'manual', command: 'Install Google Chrome from google.com/chrome' })
  add('edge', 'Microsoft Edge (browsers: edge)', fs.existsSync('/Applications/Microsoft Edge.app'), '/Applications/Microsoft Edge.app',
    { kind: 'manual', command: `cd ${FT_E2E_DIR} && npx playwright install msedge   (asks for an admin password), or install Edge from microsoft.com/edge` })

  if (['pw-chromium', 'pw-firefox', 'pw-webkit', 'pw-ffmpeg'].some(i => ids.has(i))) {
    const pw = checkout ? await playwrightPaths() : null
    // A probe that failed is "could not check", never a false "missing".
    const unknown = !pw || pw.probeError
    const why = unknown ? `could not check: ${pw?.probeError ?? 'Playwright not installed in the harness'}` : null
    add('pw-ffmpeg', "Playwright's ffmpeg (records each test's video)", unknown ? null : !!pw.ffmpeg?.exists,
      why ?? (pw.ffmpeg?.error && !pw.ffmpeg.path ? `could not read its revision: ${pw.ffmpeg.error}` : `Playwright ${pw.version} expects ${pw.ffmpeg?.path}`),
      { kind: 'auto', command: `cd ${FT_E2E_DIR} && npx playwright install ffmpeg` })
    const fx = (n, label) => add(`pw-${n}`, label, unknown ? null : !!pw[n]?.exists,
      why ?? `Playwright ${pw.version} expects ${pw[n]?.path ?? '?'}`,
      { kind: 'auto', command: `cd ${FT_E2E_DIR} && npx playwright install ${n}` })
    fx('chromium', "Playwright's Chromium (every browser run)")
    fx('firefox', "Playwright's Firefox (browsers: firefox)")
    fx('webkit', "Playwright's WebKit (browsers: safari)")
  }

  // The local Fintary stack (scripts/agent/up.sh).
  add('fintary-checkout', 'fintary checkout (FINTARY_DIR) with scripts/agent', fs.existsSync(path.join(FINTARY_DIR, 'scripts', 'agent', 'up.sh')), FINTARY_DIR,
    { kind: 'manual', command: `Set FINTARY_DIR to the fintary monorepo (looked in ${FINTARY_DIR}), then once: bash $FINTARY_DIR/scripts/agent/setup.sh` })
  if (ids.has('node-repo') || ids.has('pnpm')) {
    const want = (() => { try { return fs.readFileSync(path.join(FINTARY_DIR, '.nvmrc'), 'utf-8').trim().replace(/^v/, '') } catch { return '24' } })()
    const major = want.split('.')[0]
    const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm')
    const installed = fs.existsSync(path.join(nvmDir, 'versions', 'node')) ? fs.readdirSync(path.join(nvmDir, 'versions', 'node')) : []
    const hit = installed.find(v => v === `v${want}`) ?? installed.find(v => v.startsWith(`v${major}.`))
    add('node-repo', `Node ${want} under nvm (the repo's .nvmrc; up.sh runs nvm use)`, !!hit, hit ? `${nvmDir}/versions/node/${hit}` : `none of ${installed.join(', ') || 'no nvm versions'}`,
      { kind: 'manual', command: `nvm install ${want}` })
    const pnpm = hit && fs.existsSync(path.join(nvmDir, 'versions', 'node', hit, 'bin', 'pnpm'))
    add('pnpm', 'pnpm for that Node', pnpm || has('pnpm'), pnpm ? `${nvmDir}/versions/node/${hit}/bin/pnpm` : (has('pnpm') ? 'on PATH' : 'not found'),
      { kind: 'manual', command: `nvm use ${want} && corepack enable` })
  }
  if (ids.has('docker')) {
    let up = false
    try { execFileSync('docker', ['info'], { env: { ...process.env, PATH: childPath() }, stdio: 'ignore', timeout: 10_000 }); up = true } catch {}
    add('docker', 'Docker daemon (Postgres local-psql :5431)', has('docker') ? up : false, has('docker') ? (up ? 'running' : 'installed, not running') : 'docker not on PATH',
      { kind: 'manual', command: 'Open Docker Desktop (prepare then starts the stack through scripts/agent/up.sh)' })
  }

  const ffmpeg = has('ffmpeg')
  const brew = has('brew')
  const ffFix = brew ? { kind: 'auto', command: 'brew install ffmpeg' } : { kind: 'manual', command: 'Install Homebrew (brew.sh), then: brew install ffmpeg' }
  add('ffmpeg', 'ffmpeg (report videos)', ffmpeg, ffmpeg ? out('ffmpeg', ['-version']).split('\n')[0] : 'not on PATH', ffFix)
  const enc = ffmpeg ? out('ffmpeg', ['-hide_banner', '-encoders']) : ''
  add('ffmpeg-libvpx', 'ffmpeg with VP8 (libvpx) for .webm reels', /libvpx/.test(enc), ffmpeg ? (/libvpx/.test(enc) ? 'libvpx present' : 'this ffmpeg has no libvpx') : 'no ffmpeg',
    brew ? { kind: 'auto', command: 'brew reinstall ffmpeg' } : ffFix)
  add('ffmpeg-libx264', 'ffmpeg with H.264 (libx264) for Linear MP4s', /libx264/.test(enc), ffmpeg ? (/libx264/.test(enc) ? 'libx264 present' : 'this ffmpeg has no libx264') : 'no ffmpeg',
    brew ? { kind: 'auto', command: 'brew reinstall ffmpeg' } : ffFix)
  add('ffprobe', 'ffprobe', has('ffprobe'), has('ffprobe') ? 'on PATH' : 'not on PATH', ffFix)

  const envHas = (file, { uidOk = false } = {}) => {
    const p = path.join(FT_E2E_DIR, file)
    if (!fs.existsSync(p)) return { ok: false, detail: `${p} missing` }
    const body = fs.readFileSync(p, 'utf-8')
    const set = k => new RegExp(`^${k}=.+`, 'm').test(body)
    if (uidOk && set('E2E_UID')) return { ok: true, detail: `${p}: E2E_UID${set('E2E_EMULATOR') ? ' (emulator)' : ''} (values not read out)` }
    const missing = ['E2E_EMAIL', 'E2E_PASSWORD'].filter(k => !set(k))
    return { ok: !missing.length, detail: missing.length ? `${p}: no value for ${missing.join(', ')}` : `${p} (values not read out)` }
  }
  const envRow = (id, file, label, fix, opts) => { const r = envHas(file, opts); add(id, label, r.ok, r.detail, { kind: 'manual', command: fix }) }
  envRow('env-dev', '.env.dev', 'Test user for dev (harness/.env.dev)',
    `cp ${FT_E2E_DIR}/.env.example ${FT_E2E_DIR}/.env.dev, then fill in E2E_EMAIL / E2E_PASSWORD of a dev test user, and E2E_ACCOUNT_ID for an "E2E Test account…" -- never copy from the app repo's production env files`)
  envRow('env-uat', '.env.uat', 'Test user for uat (harness/.env.uat)',
    `cp ${FT_E2E_DIR}/.env.example ${FT_E2E_DIR}/.env.uat, then fill in the uat test user (same fintary-dev Auth pool as dev; it needs rows in the uat database)`)
  envRow('env-local', '.env.local', 'Test user for local (harness/.env.local)',
    `cp ${FT_E2E_DIR}/.env.example ${FT_E2E_DIR}/.env.local, then for the stack scripts/agent/up.sh seeds: E2E_EMULATOR=1, E2E_UID=<seeded-admin-uid>, E2E_EMAIL=<seeded-admin-email>, E2E_ACCOUNT_ID=<seeded-account-id>`, { uidOk: true })

  if (ids.has('linear-key')) {
    let keyOk = !!process.env.LINEAR_API_KEY
    if (!keyOk) { try { execFileSync('security', ['find-generic-password', '-s', 'ft-e2e-linear'], { stdio: 'ignore' }); keyOk = true } catch {} }
    add('linear-key', 'Linear API key (publish)', keyOk, keyOk ? 'found (Keychain ft-e2e-linear or LINEAR_API_KEY)' : 'none',
      { kind: 'manual', command: 'Create a personal API key in Linear (Settings > Account > Security & access > Personal API keys), then: security add-generic-password -s ft-e2e-linear -a <your email> -w' })
  }

  const byFeature = Object.fromEntries(['core', ...want.filter(f => f !== 'core')].map((f) => {
    const need = FEATURES[f] ?? []
    const missing = rows.filter(r => need.includes(r.id) && r.ok === false)
    // Chrome / Edge missing does not stop a cross-browser run: the others still run.
    const blocking = missing.filter(r => !OPTIONAL.has(r.id))
    return [f, { ready: blocking.length === 0, missing: missing.map(r => r.id) }]
  }))
  const missing = rows.filter(r => r.ok === false)
  const unchecked = rows.filter(r => r.ok === null)
  return {
    ok: missing.length === 0 && unchecked.length === 0,
    unchecked: unchecked.map(r => ({ id: r.id, label: r.label, detail: r.detail })),
    features: byFeature,
    missing: missing.map(r => ({ id: r.id, label: r.label, detail: r.detail, ...r.fix })),
    canAutoInstall: missing.filter(r => r.fix?.kind === 'auto').map(r => r.id),
    manualSteps: missing.filter(r => r.fix?.kind === 'manual').map(r => ({ id: r.id, command: r.fix.command })),
    checks: rows,
  }
}

function sh (command, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('/bin/zsh', ['-c', command], { env: { ...process.env, PATH: childPath(), HOMEBREW_NO_AUTO_UPDATE: '1' } })
    let log = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    const keep = d => { log = (log + d.toString()).slice(-4000) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, log: err.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, log }) })
  })
}

/**
 * Run the 'auto' fixes for the given ids (default: every auto fix currently
 * missing). Manual ones are returned with their command, never run.
 * @param {{ items?: string[], features?: string[] }} opts
 */
export async function installToolkit ({ items, features } = {}) {
  const before = await checkToolkit({ features })
  const targets = items?.length ? before.missing.filter(m => items.includes(m.id)) : before.missing
  const results = []
  const done = new Set()
  for (const m of targets) {
    if (m.kind !== 'auto') { results.push({ id: m.id, ran: false, reason: 'manual step', command: m.command }); continue }
    if (done.has(m.command)) { results.push({ id: m.id, ran: true, ok: true, note: 'covered by an earlier step' }); continue }
    done.add(m.command)
    const started = Date.now()
    const r = await sh(m.command, 20 * 60_000)
    results.push({ id: m.id, ran: true, ok: r.code === 0, command: m.command, seconds: Math.round((Date.now() - started) / 1000), log: r.code === 0 ? undefined : r.log.slice(-800) })
  }
  const unknown = (items ?? []).filter(i => !before.missing.some(m => m.id === i) && !before.checks.some(c => c.id === i))
  const after = await checkToolkit({ features })
  return { ok: after.ok, results, unknown, after: { features: after.features, missing: after.missing } }
}

