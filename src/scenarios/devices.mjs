// Multi-device runs: which screens exist, and the case × screen report.
// Both come from the harness itself -- the device list is parsed out of
// harness/lib/devices.ts and the report is scripts/build-device-report.mjs --
// so this server never keeps a second copy of either.
import fs from 'node:fs'
import path from 'node:path'
import { FT_E2E_DIR, runInHarness } from '../ft-e2e.mjs'
import { DEFAULT_ENV, knownEnv } from '../env.mjs'
import { resolveRunDir } from './runs.mjs'

/** [{ name, label, descriptor }] in registry order, read from harness/lib/devices.ts. */
export function listDevices () {
  const file = path.join(FT_E2E_DIR, 'lib', 'devices.ts')
  if (!fs.existsSync(file)) return []
  const src = fs.readFileSync(file, 'utf-8')
  const defaults = src.match(/DEFAULT_DEVICES = \[([^\]]*)\]/)?.[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) ?? []
  return [...src.matchAll(/from\('([a-z0-9-]+)', '([^']+)', '([^']+)'(?:, \{ width: (\d+), height: (\d+) \})?\)/g)]
    .map(m => ({ name: m[1], label: m[2], descriptor: m[3], default: defaults.includes(m[1]) }))
}

/** Named sets from lib/devices.ts DEVICE_GROUPS ("iphones", "android", "phones", ...), plus "default" and "all". */
export function listDeviceGroups () {
  const file = path.join(FT_E2E_DIR, 'lib', 'devices.ts')
  if (!fs.existsSync(file)) return {}
  const src = fs.readFileSync(file, 'utf-8')
  const body = src.match(/DEVICE_GROUPS[^=]*=\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const groups = {}
  for (const m of body.matchAll(/^\s*([a-z0-9-]+):\s*\[([^\]]*)\]/gm)) groups[m[1]] = m[2].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) ?? []
  groups.default = listDevices().filter(d => d.default).map(d => d.name)
  groups.all = listDevices().map(d => d.name)
  return groups
}

/**
 * The browsers a cross-browser run can use, and whether each is installed on
 * this machine. Mirrors harness/lib/browsers.ts (names and what each really is).
 * Playwright's own builds (chromium / firefox / safari) report installed: true
 * here; whether their download is in the cache is the toolkit gate's job
 * (check_toolkit pw-chromium / pw-firefox / pw-webkit), which names the fix.
 */
export function listBrowsers () {
  return [
    { name: 'chromium', label: 'Chromium', engine: 'Chromium', what: "Playwright's Chromium build -- the default for every run", installed: true },
    { name: 'chrome', label: 'Chrome', engine: 'Chromium', what: 'Google Chrome, the installed app', installed: fs.existsSync('/Applications/Google Chrome.app'), install: 'Install Google Chrome from google.com/chrome' },
    { name: 'edge', label: 'Edge', engine: 'Chromium', what: 'Microsoft Edge, the installed app', installed: fs.existsSync('/Applications/Microsoft Edge.app'), install: 'npx playwright install msedge (asks for an admin password), or install Edge from microsoft.com' },
    { name: 'firefox', label: 'Firefox', engine: 'Gecko', what: "Playwright's Firefox build (stock Firefox + automation patches); records headless; no isMobile emulation", installed: true },
    { name: 'safari', label: 'Safari (WebKit)', engine: 'WebKit', what: "Playwright's WebKit build: Safari's engine, not Safari.app", installed: true },
  ]
}
export const BROWSER_NAMES = ['chromium', 'chrome', 'edge', 'firefox', 'safari']

export const DEVICE_NAMES = listDevices().map(d => d.name)
export const DEVICE_GROUP_NAMES = Object.keys(listDeviceGroups())
export const DEFAULT_DEVICES = listDevices().filter(d => d.default).map(d => d.name)

/**
 * Builds (or rebuilds) DEVICES.md, devices.html, devices.json and
 * TEAM-UPDATE.md for one multi-device run and returns the summary.
 * @param {{ ticket: string, env?: string, run?: string }} opts
 */
export async function buildDeviceReport ({ ticket, env: envName = DEFAULT_ENV, run, scopeNote, skippedBrowsers }) {
  const env = knownEnv(envName)
  if (!env?.evidenceDir) return { ok: false, error: `Environment "${envName}" records no evidence.` }
  const dir = resolveRunDir(env, ticket, run)
  if (!dir) return { ok: false, error: `No ${run ? `run "${run}"` : 'run'} recorded for ${ticket} on ${env.name}.` }
  const runId = path.basename(dir)
  const res = await runInHarness('node', ['scripts/build-device-report.mjs', ticket, env.harnessEnv, runId], {
    timeoutMs: 60_000,
    // Cases deliberately left out of this run, listed under Scope -> not run.
    extraEnv: {
      ...(scopeNote ? { E2E_SCOPE_NOTE: scopeNote } : {}),
      ...(skippedBrowsers?.length ? { E2E_BROWSERS_SKIPPED: skippedBrowsers.join(', ') } : {}),
    },
  })
  const jsonFile = path.join(dir, 'devices.json')
  if (res.code !== 0 || !fs.existsSync(jsonFile)) {
    return {
      ok: false,
      error: res.code === 2
        ? `Run ${runId} has no browser tests (API-only), so there is nothing to report per screen.`
        : `build-device-report.mjs exited ${res.code}`,
      detail: (res.stderr || res.stdout).slice(-600),
    }
  }
  const report = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'))
  return {
    ok: true,
    ticket,
    env: env.name,
    run: runId,
    verdict: report.verdict,
    totals: report.totals,
    devices: report.devices,
    matrix: report.matrix.map(r => ({
      case: r.case,
      ...Object.fromEntries(Object.entries(r.results).map(([d, x]) => [d, x ? `${x.status.toUpperCase()} · ${x.layout}` : null])),
    })),
    // Breaks and failures in full; warnings counted (they are in DEVICES.md).
    issues: report.findings.filter(f => f.severity !== 'warn'),
    warnings: report.findings.filter(f => f.severity === 'warn').length,
    files: {
      ...report.files,
      reel: fs.existsSync(path.join(dir, 'report.webm')) ? path.join(dir, 'report.webm') : null,
    },
    teamUpdate: fs.existsSync(report.files.teamUpdate) ? fs.readFileSync(report.files.teamUpdate, 'utf-8') : null,
    openCommand: `open "${report.files.html}"`,
  }
}
