#!/usr/bin/env node
// Make (or check) the cached browser session the signed-in specs use.
//
//   node scripts/sign-in.mjs --env dev            # reuse the cached session if it still works, else sign in
//   node scripts/sign-in.mjs --env dev --force    # sign in again
//   node scripts/sign-in.mjs --env dev --headed   # watch the sign-in form being filled
//   node scripts/sign-in.mjs --env dev --check    # only say whether the cached session works
//
// Credentials: E2E_EMAIL / E2E_PASSWORD (or E2E_UID on local) in harness/.env.<env>.
// Prints one JSON line; never prints a token or a password.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cfg = require('../lib/config.cjs')
const firebase = require('../lib/firebase.cjs')

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const has = k => argv.includes(`--${k}`)

const env = cfg.envConfig(opt('env', cfg.registry().default))
const out = r => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1) }

if (has('check')) {
  const s = cfg.sessionInfo(env.authPath)
  try {
    await firebase.idToken(env)
    out({ ok: true, env: env.name, session: s.detail, uid: s.uid })
  } catch (err) {
    out({ ok: false, env: env.name, session: s.detail, error: err.message })
  }
}

try {
  const started = Date.now()
  await firebase.ensureSession(env, { force: has('force'), headed: has('headed') })
  const s = cfg.sessionInfo(env.authPath)
  out({ ok: true, env: env.name, session: s.detail, uid: s.uid, authFile: env.authPath, ms: Date.now() - started })
} catch (err) {
  out({ ok: false, env: env.name, error: err.message })
}
