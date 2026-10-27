// Fintary e2e harness config. Driven by environment variables so the MCP
// server, the CLI and a bare `npx playwright test` all run the same thing:
//
//   ENV=dev|uat|local      which environment (config/environments.json; default dev)
//   E2E_TICKET=PLT-1234    the ticket folder under tests/ -- also names the evidence folder
//   E2E_WRITES=1           also run cases tagged @writes (left out by default: dev is shared)
//   E2E_RUN_ID=<id>        this run's folder name (default: now, YYYY-MM-DD_HH-MM-SS)
//   E2E_DEVICES=a,b|group  one project per screen (lib/devices.ts)
//   E2E_BROWSERS=a,b|all   one project per browser (lib/browsers.ts), x screens
//   DEMO=1                 narrated recording at 1600x1000, headed
//   HEADLESS=0             show the browser
//
// Evidence: tickets/<ticket>/<evidence dir>/runs/<run id>/{results.json, report/, artifacts/}
// -- a new run never overwrites an older one. scripts/build-report.mjs adds
// EVIDENCE.md, RUNS.md and the `latest` link afterwards.
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Project } from '@playwright/test'
import { expandDevices } from './lib/devices'
import { BROWSERS, expandBrowsers } from './lib/browsers'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cfg = require('./lib/config.cjs')

const env = cfg.envConfig(process.env.ENV || cfg.registry().default)
const ticket = process.env.E2E_TICKET || 'adhoc'
// Workers re-evaluate this file; the main process pins the id for them.
const runId = process.env.E2E_RUN_ID || (process.env.E2E_RUN_ID = cfg.newRunId())
const runDir = cfg.runDir(ticket, env, runId)
const DEMO = !!process.env.DEMO
const headless = !DEMO && process.env.HEADLESS !== '0'

const DEMO_VIEWPORT = { width: 1600, height: 1000 }
const DESKTOP_VIEWPORT = { width: 1440, height: 900 }

const split = (v?: string) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean)
const deviceList = split(process.env.E2E_DEVICES)
const browserList = split(process.env.E2E_BROWSERS)
const multi = deviceList.length > 0 || browserList.length > 0

const screens = multi ? expandDevices(deviceList.length ? deviceList : ['desktop']) : []
const browsers = browserList.length ? expandBrowsers(browserList) : [BROWSERS.chromium]

const browserProjects: Project[] = multi
  ? screens.flatMap(s => browsers.map((b) => {
    const use: Record<string, any> = { ...s.use, ...b.use }
    if (!b.mobileEmulation) delete use.isMobile
    // Phone recordings at their own size; the reel pillarboxes them.
    const viewport = DEMO && s.kind === 'desktop' ? DEMO_VIEWPORT : use.viewport
    return {
      name: `device-${s.name}${browserList.length ? `--${b.name}` : ''}`,
      testIgnore: /.*\.api\.spec\.ts$/,
      metadata: { device: s.name, deviceLabel: s.label, kind: s.kind, browser: b.name, browserLabel: b.label, mobileEmulation: b.mobileEmulation },
      use: { ...use, viewport, video: { mode: 'on', size: viewport } },
    } satisfies Project
  }))
  : [{
    name: 'chromium',
    testIgnore: /.*\.api\.spec\.ts$/,
    metadata: { device: 'desktop', deviceLabel: DEMO ? 'Desktop 1600x1000' : 'Desktop 1440x900', kind: 'desktop', browser: 'chromium', browserLabel: 'Chromium', mobileEmulation: true },
    use: {
      browserName: 'chromium',
      viewport: DEMO ? DEMO_VIEWPORT : DESKTOP_VIEWPORT,
      video: { mode: 'on', size: DEMO ? DEMO_VIEWPORT : DESKTOP_VIEWPORT },
    },
  }]

// One record of what this run is, for the report scripts (written once, by the main process).
if (!process.env.TEST_WORKER_INDEX) {
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'run-meta.json'), JSON.stringify({
    ticket,
    env: env.name,
    envLabel: env.label,
    runId,
    startedAt: new Date().toISOString(),
    demo: DEMO,
    urls: { web: env.webURL, api: env.apiURL },
    accountId: env.accountId || null,
    writes: process.env.E2E_WRITES === '1',
    projects: browserProjects.map(p => ({ name: p.name, ...(p.metadata as object) })),
    multiDevice: multi,
  }, null, 2))
}

export default defineConfig({
  testDir: './tests',
  outputDir: path.join(runDir, 'artifacts'),
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // One browser at a time: narration stays readable and the shared dev data
  // is not raced by our own parallel cases.
  workers: Number(process.env.E2E_WORKERS || 1),
  retries: 0,
  // Cases that create, change or delete data run only when asked for.
  grepInvert: process.env.E2E_WRITES === '1' ? undefined : /@writes/,
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(runDir, 'results.json') }],
    ['html', { outputFolder: path.join(runDir, 'report'), open: 'never' }],
  ],
  use: {
    headless,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
    launchOptions: DEMO ? { slowMo: 120 } : {},
    locale: 'en-US',
    timezoneId: process.env.E2E_TIMEZONE || 'America/New_York', // the zone the app itself defaults to most
  },
  projects: [
    // API-only specs: no browser, every call through api/adminApi/apiFor recorded as evidence.
    { name: 'api', testMatch: /.*\.api\.spec\.ts$/, metadata: { api: true } },
    ...browserProjects,
  ],
})
