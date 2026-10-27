// Environment registry resolution. The LIST lives in config/environments.json;
// this file only resolves against it. The MCP server, bin/ft-e2e-run.mjs and the
// harness (harness/lib/config.cjs) all read that one file, so there is exactly one
// answer to "which environments exist".
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const registryPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'environments.json',
)
const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))

/** Ordered environment records, as declared. */
export const ENVIRONMENTS = data.environments
export const ENV_NAMES = ENVIRONMENTS.map(e => e.name)
export const DEFAULT_ENV = data.default

/**
 * The environment record named by `value`, or null when it names none.
 * Use where a wrong answer is worse than no answer.
 */
export function knownEnv (value) {
  return ENVIRONMENTS.find(e => e.name === value) ?? null
}

/** The environment record for `value`, falling back to the default. */
export function resolveEnv (value) {
  return knownEnv(value) ?? knownEnv(DEFAULT_ENV)
}

/**
 * Throws unless the environment both exists and can actually host a test run.
 * Reachability-only callers (preflight) should use knownEnv instead -- an
 * unwired environment is still worth probing, just not worth running against.
 */
export function requireWiredEnv (value) {
  const env = knownEnv(value)
  if (!env) {
    throw new Error(`Unknown environment "${value}". Known: ${ENV_NAMES.join(', ')}.`)
  }
  if (!env.wired) {
    throw new Error(
      `Environment "${value}" is declared but not wired for test runs: ${env.notes} `
      + `Wired environments: ${ENVIRONMENTS.filter(e => e.wired).map(e => e.name).join(', ')}.`,
    )
  }
  return env
}

/**
 * The env vars to export when spawning a harness command for this environment.
 * `demo` wins over `headless`: the harness forces a headed browser for DEMO=1
 * so the narrated recording is what a person watching would see.
 */
export function spawnEnvFor (env, { ticket, headless, demo, voice, devices, browsers } = {}) {
  const out = { ENV: env.harnessEnv ?? env.name }
  if (ticket) out.E2E_TICKET = ticket
  // Multi-device run: one device-<name> project per screen (harness/lib/devices.ts).
  if (devices?.length) out.E2E_DEVICES = devices.join(',')
  // Cross-browser run: chromium / chrome / edge / firefox / safari (harness/lib/browsers.ts).
  if (browsers?.length) out.E2E_BROWSERS = browsers.join(',')
  if (demo) out.DEMO = '1'
  // Spoken narration rides on the demo recording (harness/fixtures/voice.ts, macOS `say`).
  if (demo && voice) out.E2E_VOICE = '1'
  else if (headless) out.HEADLESS = '1'
  return out
}
