// The run scenario: gate, run, build evidence, summarize. Each step is the
// harness's own (playwright.config.ts, scripts/build-report.mjs) -- this
// sequences them and reports one structured result.
import fs from 'node:fs'
import path from 'node:path'
import { FT_E2E_DIR, runInHarness } from '../ft-e2e.mjs'
import { DEFAULT_ENV, requireWiredEnv, spawnEnvFor } from '../env.mjs'
import { preflight } from './preflight.mjs'
import { summarizeRun, oneLine } from './summarize.mjs'
import { evidenceRootFor, newRunId } from './runs.mjs'
import { refreshLogin } from './login.mjs'
import { checkToolkit } from './toolkit.mjs'
import { BROWSER_NAMES, buildDeviceReport, DEVICE_GROUP_NAMES, DEVICE_NAMES, listBrowsers } from './devices.mjs'

// A blocker the run can fix itself: sign in again through the web's form.
const isLoginBlocker = b => b.startsWith('cached session') || b.startsWith('test user')

/**
 * @param {{
 *   env?: string, ticket?: string, grep?: string, headed?: boolean, demo?: boolean, voice?: boolean, apiOnly?: boolean,
 *   skipPreflight?: boolean, buildEvidence?: boolean, timeoutMs?: number, refreshLogin?: boolean,
 *   devices?: string[], layoutStrict?: boolean, browsers?: string[], grepInvert?: string, writes?: boolean
 * }} opts
 */
export async function run ({
  env: envName = DEFAULT_ENV, ticket, grep, headed = false, demo = false, voice = true, apiOnly = false,
  skipPreflight = false, buildEvidence = true, timeoutMs = 600_000, refreshLogin: mayRefresh = true,
  devices = [], layoutStrict = false, browsers = [], grepInvert, writes = false, skipToolkitCheck = false,
} = {}) {
  if (!ticket && !grep) {
    return { ok: false, error: 'Refusing to run the whole suite unscoped -- pass ticket and/or grep.' }
  }
  if ((devices.length || browsers.length) && apiOnly) {
    return { ok: false, error: 'devices/browsers and apiOnly do not combine: API specs open no browser.' }
  }
  // 'all' = one per engine (Chromium, Gecko, WebKit), same as harness/lib/browsers.ts.
  const expanded = [...new Set(browsers.flatMap(b => (b === 'all' ? ['chromium', 'firefox', 'safari'] : [b === 'webkit' ? 'safari' : b === 'msedge' ? 'edge' : b])))]
  const unknownBrowsers = expanded.filter(b => !BROWSER_NAMES.includes(b))
  if (unknownBrowsers.length) return { ok: false, error: `Unknown browser(s): ${unknownBrowsers.join(', ')}. Known: ${BROWSER_NAMES.join(', ')}.` }
  const browserInfo = listBrowsers()
  const skippedBrowsers = expanded.filter(b => !browserInfo.find(x => x.name === b)?.installed)
  const runBrowsers = expanded.filter(b => !skippedBrowsers.includes(b))
  if (expanded.length && !runBrowsers.length) {
    return { ok: false, error: `None of the requested browsers is installed (${skippedBrowsers.join(', ')}).`, install: browserInfo.filter(b => skippedBrowsers.includes(b.name)).map(b => `${b.label}: ${b.install}`) }
  }
  const unknownDevices = devices.filter(d => !DEVICE_NAMES.includes(d) && !DEVICE_GROUP_NAMES.includes(d))
  if (unknownDevices.length) {
    return { ok: false, error: `Unknown device(s): ${unknownDevices.join(', ')}. Screens: ${DEVICE_NAMES.join(', ')}. Groups: ${DEVICE_GROUP_NAMES.join(', ')}.` }
  }

  let env
  try {
    env = requireWiredEnv(envName)
  } catch (err) {
    return { ok: false, error: err.message }
  }

  const ticketName = ticket ?? 'adhoc'

  // Toolkit gate: only what THIS run needs, so a missing Firefox does not
  // block a Chrome run, and a missing tool is named with its install command
  // instead of surfacing as "Executable doesn't exist" halfway through.
  if (!skipToolkitCheck) {
    const needIds = new Set(['harness-deps'])
    if (!apiOnly) needIds.add('pw-ffmpeg')
    if (!apiOnly && (!runBrowsers.length || runBrowsers.includes('chromium'))) needIds.add('pw-chromium')
    for (const b of runBrowsers) {
      if (b === 'firefox') needIds.add('pw-firefox')
      if (b === 'safari') needIds.add('pw-webkit')
    }
    const tk = await checkToolkit({ features: ['browsers'] })
    const missing = tk.missing.filter(m => needIds.has(m.id))
    if (missing.length) {
      return {
        ok: false,
        stage: 'toolkit',
        error: `Missing on this machine: ${missing.map(m => m.label).join(', ')}.`,
        missing: missing.map(m => ({ id: m.id, kind: m.kind, command: m.command })),
        hint: missing.some(m => m.kind === 'auto') ? 'install_toolkit can install the "auto" ones; ask the user first.' : undefined,
      }
    }
  }

  let login = null
  if (!skipPreflight) {
    let gate = await preflight({ env: env.name, ticket })
    // A dead session with a test user on file is the one blocker the run can fix
    // itself: sign in again, then gate once more. Anything else (API down, no test
    // user, no specs) still stops the run with its own fix.
    if (!gate.canRun && mayRefresh && gate.blocking.length && gate.blocking.every(isLoginBlocker)) {
      login = await refreshLogin(env)
      gate = await preflight({ env: env.name, ticket })
    }
    if (!gate.canRun) {
      return {
        ok: false,
        stage: 'preflight',
        error: login
          ? `The login refresh (${login.how}) did not produce a fresh session, so the run did not start.`
          : 'Preflight blocked the run. Fix these or pass skipPreflight to override.',
        blocking: gate.blocking,
        login,
        preflight: gate,
      }
    }
  }

  const args = ['playwright', 'test']
  if (ticket) args.push(path.join('tests', ticket))
  if (grep) args.push('--grep', grep)
  // A CLI --grep-invert replaces the config's, so keep @writes out here too unless asked for.
  if (grepInvert) args.push('--grep-invert', writes ? grepInvert : `(?:${grepInvert})|@writes`)
  // API-only: just the *.api.spec.ts files, no browser. The ID token, when a spec
  // uses the signed-in api fixture, comes from the same session as the browser specs.
  if (apiOnly) args.push('--project=api')
  // DEMO=1 forces headed inside the harness config already.
  if (headed && !demo) args.push('--headed')

  // This run's own folder, named for when it started. Passing the id down
  // means Playwright, build-report.mjs and the read-back below all agree on it.
  const runId = newRunId()
  const dir = path.join(evidenceRootFor(env, ticketName), 'runs', runId)

  const started = Date.now()
  const res = await runInHarness('npx', args, {
    timeoutMs,
    extraEnv: {
      ...spawnEnvFor(env, { ticket: ticketName, headless: !headed, demo, voice, devices, browsers: runBrowsers }),
      E2E_RUN_ID: runId,
      ...(layoutStrict ? { E2E_LAYOUT_STRICT: '1' } : {}),
      // @writes cases are left out by playwright.config.ts unless this is set.
      ...(writes ? { E2E_WRITES: '1' } : {}),
    },
  })

  const resultsFile = path.join(dir, 'results.json')

  if (!fs.existsSync(resultsFile)) {
    return {
      ok: false,
      stage: 'run',
      runId,
      login,
      exitCode: res.code,
      timedOut: res.timedOut,
      error: `Playwright produced no results.json at ${resultsFile}.`,
      output: `${res.stdout}\n${res.stderr}`.slice(-4000),
    }
  }

  let evidence = null
  if (buildEvidence) {
    // The harness's own EVIDENCE.md builder -- it also stamps what was tested (the
    // fintary branch+commit on local; the live API commit and web build elsewhere),
    // which is why it runs here rather than being reimplemented.
    const rep = await runInHarness('node', ['scripts/build-report.mjs', ticketName, env.harnessEnv, runId], { timeoutMs: 60_000 })
    evidence = {
      ok: rep.code === 0,
      path: path.join(dir, 'EVIDENCE.md'),
      detail: rep.code === 0 ? 'EVIDENCE.md rebuilt' : (rep.stderr || rep.stdout).slice(-300),
    }
  }

  // Multi-device: the case x screen matrix, layout breaks and side-by-side screens.
  const deviceReport = (devices.length || runBrowsers.length) && buildEvidence
    ? await buildDeviceReport({ ticket: ticketName, env: env.name, run: runId, skippedBrowsers })
    : null

  const summary = summarizeRun(resultsFile)
  return {
    ok: summary.passed,
    stage: 'complete',
    env: env.name,
    ticket: ticketName,
    grep: grep ?? null,
    runId,
    runDir: dir,
    latestDir: path.join(evidenceRootFor(env, ticketName), 'latest'),
    login,
    demo,
    voice: demo && voice && process.platform === 'darwin',
    apiOnly,
    writes,
    devices: devices.length ? devices : null,
    browsers: runBrowsers.length ? runBrowsers : null,
    browsersSkipped: skippedBrowsers.length
      ? skippedBrowsers.map(b => ({ browser: b, reason: 'not installed', install: browserInfo.find(x => x.name === b)?.install ?? null }))
      : null,
    deviceReport,
    exitCode: res.code,
    timedOut: res.timedOut,
    wallClockMs: Date.now() - started,
    headline: oneLine(summary),
    summary,
    evidence,
    reportOpenCommand: `cd ${FT_E2E_DIR} && npx playwright show-report ${path.relative(FT_E2E_DIR, path.join(dir, 'report'))}`,
  }
}
