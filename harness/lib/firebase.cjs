// Firebase sign-in for the harness, two halves:
//
//  1. A BROWSER session: the web keeps the Firebase user in IndexedDB
//     (firebaseLocalStorageDb), so the session is a Playwright storageState saved
//     WITH indexedDB. Made once and reused by every test:
//       - password (dev, uat, local): the web's own sign-in form, like a person
//         (email -> auth_handler/check-contact -> password -> "Sign In"), then
//         wait for the account menu [data-testid="user-menu-button"];
//       - uid (local only): the fintary repo's own scripts --
//         SKILLS/run-app/scripts/sign-in.mts (fintary-dev custom token via your ADC)
//         or emulator-sign-in.mts (auth emulator, offline) -- and their storage-state.json.
//
//  2. An ID TOKEN for API calls (`authentication: Bearer <token>`), taken from that
//     same stored user (stsTokenManager) and refreshed through securetoken when it
//     has under five minutes left. A refresh that fails means the session is dead:
//     ensureSession() signs in again.
//
// Tokens and passwords are never printed or logged; sessions are written 0600.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const cfg = require('./config.cjs')

const MENU = '[data-testid="user-menu-button"]'
const EMULATOR_AUTH = 'http://127.0.0.1:4002'

function writePrivate (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Password sign-in through the web's form. Returns { ok, error?, shot? }. */
async function passwordSignIn (env, creds, { headed = false } = {}) {
  const { chromium } = require('@playwright/test')
  const browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  try {
    await page.goto(cfg.webUrl(env, '/sign-in'), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const email = page.locator('#emailAddress')
    await email.waitFor({ state: 'visible', timeout: 45_000 })
    // The form asks the API whether the address is an SSO one; let that answer
    // land before the password, or it can reset the form.
    const checked = page.waitForResponse(r => r.url().includes('auth_handler/check-contact'), { timeout: 15_000 }).catch(() => null)
    await email.fill(creds.email)
    await email.press('Tab')
    await checked
    await page.locator('#password').fill(creds.password)
    const button = page.getByRole('button', { name: 'Sign In', exact: true })
    if (!(await button.isVisible().catch(() => false))) {
      const sso = await page.getByRole('button', { name: 'Single Sign-On' }).isVisible().catch(() => false)
      throw new Error(sso ? 'this address signs in with SSO; use a password test user' : 'the "Sign In" button did not appear')
    }
    await button.click()
    const menu = page.locator(MENU)
    const outcome = await Promise.race([
      menu.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'ok'),
      page.locator('.MuiAlert-message, [role="alert"]').first().waitFor({ state: 'visible', timeout: 60_000 })
        .then(async () => `the form said: ${(await page.locator('.MuiAlert-message, [role="alert"]').first().innerText()).trim().slice(0, 200)}`),
    ]).catch(e => `no account menu within 60 s (${String(e.message).split('\n')[0]})`)
    if (outcome !== 'ok') throw new Error(outcome)
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    const state = await context.storageState({ indexedDB: true })
    writePrivate(env.authPath, JSON.stringify(state))
    return { ok: true }
  } catch (err) {
    const shot = path.join(path.dirname(env.authPath), `sign-in-failed-${env.harnessEnv}.png`)
    await page.screenshot({ path: shot }).catch(() => {})
    return { ok: false, error: String(err.message).split('\n')[0], shot }
  } finally {
    await browser.close()
  }
}

/** Local only: the repo's own custom-token / emulator sign-in scripts, which print { storageState } as JSON. */
function uidSignIn (env, creds) {
  const script = env.emulator ? 'emulator-sign-in.mts' : 'sign-in.mts'
  const file = path.join(cfg.FINTARY_DIR, 'SKILLS', 'run-app', 'scripts', script)
  if (!fs.existsSync(file)) return { ok: false, error: `${script} not found under ${cfg.FINTARY_DIR}/SKILLS/run-app/scripts (set FINTARY_DIR)` }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-e2e-sign-in-'))
  const args = ['--uid', creds.uid, '--out', out, '--url', cfg.webUrl(env, '/')]
  if (env.emulator && creds.email) args.push('--email', creds.email)
  const [maj, min] = process.versions.node.split('.').map(Number)
  const flags = maj > 23 || (maj === 23 && min >= 6) ? [] : ['--experimental-strip-types']
  const r = spawnSync(process.execPath, [...flags, file, ...args], { cwd: cfg.FINTARY_DIR, encoding: 'utf-8', timeout: 180_000 })
  try {
    if (r.status !== 0) {
      const hint = (r.stderr || '').split('\n').filter(l => /sign-in failed|hint:|Error/i.test(l)).slice(-3).join(' | ')
      return { ok: false, error: `${script} exited ${r.status}: ${hint || 'see its output'}` }
    }
    const line = (r.stdout || '').trim().split('\n').filter(l => l.startsWith('{')).pop()
    const result = JSON.parse(line)
    writePrivate(env.authPath, fs.readFileSync(result.storageState, 'utf-8'))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `${script}: ${err.message}` }
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
}

/** A fresh ID token for API calls, refreshing through securetoken when needed. Throws when the session is dead. */
const memo = new Map()
async function idToken (env) {
  const cached = memo.get(env.authPath)
  if (cached && cached.exp - Date.now() > 5 * 60_000) return cached.token
  const s = cfg.sessionInfo(env.authPath)
  if (!s.usable) throw Object.assign(new Error(`no usable session: ${s.detail}`), { needsSignIn: true })
  if (s.accessToken && s.msLeft > 5 * 60_000) {
    memo.set(env.authPath, { token: s.accessToken, exp: Date.now() + s.msLeft })
    return s.accessToken
  }
  const base = env.emulator ? `${EMULATOR_AUTH}/securetoken.googleapis.com` : 'https://securetoken.googleapis.com'
  const res = await fetch(`${base}/v1/token?key=${encodeURIComponent(s.apiKey || 'emulator')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken }),
    signal: AbortSignal.timeout(20_000),
  }).catch(err => ({ ok: false, status: 0, json: async () => ({ error: { message: err.message } }) }))
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.id_token) {
    throw Object.assign(new Error(`token refresh failed (${res.status} ${body?.error?.message ?? ''})`.trim()), { needsSignIn: true })
  }
  memo.set(env.authPath, { token: body.id_token, exp: Date.now() + Number(body.expires_in || 3600) * 1000 })
  return body.id_token
}

let pending = null
/** A working browser session for `env` (path to its storageState), signing in only when the cached one is gone or dead. */
async function ensureSession (env, { force = false, headed = false } = {}) {
  if (!force) {
    try { await idToken(env); return env.authPath } catch (err) { if (!err.needsSignIn) throw err }
  }
  if (!pending) {
    pending = (async () => {
      const creds = cfg.credentials(env)
      if (!creds) {
        throw new Error(`No working session for ${env.name} (${cfg.sessionInfo(env.authPath).detail}) and no test user in harness/${env.envFile}: `
          + 'set E2E_EMAIL and E2E_PASSWORD' + (env.name === 'local' ? ', or E2E_UID for the repo\'s custom-token sign-in.' : '.'))
      }
      const r = creds.kind === 'uid' ? uidSignIn(env, creds) : await passwordSignIn(env, creds, { headed })
      if (!r.ok) throw new Error(`Sign-in failed for ${cfg.maskEmail(creds.email) || creds.uid} on ${env.name} (${creds.source}): ${r.error}${r.shot ? ` -- screenshot: ${r.shot}` : ''}`)
      memo.delete(env.authPath)
      await idToken(env)
      return env.authPath
    })().finally(() => { pending = null })
  }
  return pending
}

module.exports = { MENU, ensureSession, idToken, passwordSignIn, uidSignIn }
