// Fixes what preflight can safely fix, and is explicit about what it will not
// touch. Deliberately NOT automated here:
//   - Docker Desktop and the first-time repo setup (scripts/agent/setup.sh) --
//     machine-level, the user's call,
//   - credentials (never copied from the fintary repo's env files: tracked ones hold
//     live secrets, and the app repo's production env files point at production),
//   - anything on :5432 (the production database proxy).
// Each of those is reported as a manual step instead of being half-attempted.
import fs from 'node:fs'
import path from 'node:path'
import { FT_E2E_DIR, runInHarness } from '../ft-e2e.mjs'
import { knownEnv } from '../env.mjs'
import { preflight } from './preflight.mjs'
import { refreshLogin } from './login.mjs'

/**
 * @param {{ env?: string, ticket?: string, startStack?: boolean, signIn?: boolean, timeoutMs?: number }} opts
 */
export async function prepare ({
  env: envName = 'dev', ticket, startStack = true, signIn = true, timeoutMs = 600_000,
} = {}) {
  const env = knownEnv(envName)
  if (!env) return { ok: false, actions: [], manual: [], error: `Unknown environment "${envName}".` }

  const actions = []
  const manual = []

  if (!fs.existsSync(path.join(FT_E2E_DIR, 'node_modules', '@playwright', 'test'))) {
    const res = await runInHarness('npm', ['install', '--no-audit', '--no-fund'], { timeoutMs: 300_000 })
    actions.push({
      step: 'npm install (harness)',
      ok: res.code === 0,
      detail: res.code === 0 ? 'dependencies installed' : (res.stderr || '').slice(-400),
    })
  } else {
    actions.push({ step: 'npm install (harness)', ok: true, detail: 'already installed, skipped' })
  }

  // Only local has a stack to start; dev and uat are deployed.
  if (env.name === 'local' && startStack) {
    const status = await runInHarness('bash', ['scripts/dev-up.sh', '--status'], { timeoutMs: 30_000 })
    if (status.code === 0) {
      actions.push({ step: 'local stack', ok: true, detail: 'web and api already up, not restarted' })
    } else {
      const res = await runInHarness('bash', ['scripts/dev-up.sh', '--up'], { timeoutMs })
      const out = `${res.stdout}${res.stderr ? `\n${res.stderr}` : ''}`
      actions.push({
        step: 'dev-up.sh --up (scripts/agent/up.sh)',
        ok: res.code === 0 && !res.timedOut,
        detail: res.timedOut ? `timed out after ${timeoutMs}ms` : out.trim().split('\n').slice(-14).join('\n'),
      })
      if (/Cannot connect to the Docker daemon|docker.*not running/i.test(out)) manual.push('Docker Desktop is not running -- open it (machine-level app, your call), then prepare again.')
      if (/setup\.sh/i.test(out) && res.code !== 0) manual.push('First time on this machine: bash <fintary>/scripts/agent/setup.sh (deps, .env.local, images), then prepare again.')
    }
  }

  let after = await preflight({ env: envName, ticket })
  const sessionDead = after.checks.some(c => c.name === 'cached session' && !c.ok)
  const hasUser = after.checks.some(c => c.name === 'test user' && c.ok)
  if (signIn && env.wired && sessionDead && hasUser) {
    const login = await refreshLogin(env)
    actions.push({ step: 'sign in (scripts/sign-in.mjs)', ok: login.ok, detail: login.detail })
    after = await preflight({ env: envName, ticket })
  }

  for (const check of after.checks) {
    if (check.ok || !check.blocking) continue
    if (/test user|cached session/.test(check.name)) {
      manual.push(`Test user -- put E2E_EMAIL / E2E_PASSWORD for the ${env.label} test user in harness/${env.envFile} (see .env.example)`
        + (env.name === 'local' ? ', or E2E_EMULATOR=1 + E2E_UID=<seeded-admin-uid> + E2E_EMAIL=<seeded-admin-email> for the stack scripts/agent/up.sh seeds.' : '.'))
    }
    if (/Postgres|auth emulator/.test(check.name)) manual.push(`${check.name} is down -- check Docker Desktop, then dev_stack_up.`)
    if (/safety preflight/.test(check.name)) manual.push(`The fintary repo's own safety check blocked: ${check.detail}. Fix that first (SKILLS/run-app/references/safety.md); never point anything at :5432.`)
  }

  return {
    ok: after.canRun,
    env: env.name,
    actions,
    manual: [...new Set(manual)],
    preflight: after,
  }
}
