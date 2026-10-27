// The one import every spec uses:
//
//   import { test, appTest, expect } from '../../fixtures'
//
// Fixtures:
//   app        the environment under test: app.url('/policies'), app.accountId, app.env
//   page       the usual page, plus: video (always), console-error capture, the
//              production write guard, DEMO narration, the device layout audit
//   evidence   evidence.snap(name, { mark, boxes, note }) -> clean PNG + annotated figure
//   demo       demo.circle(loc, label) / demo.point(loc, label) / demo.callout(text); no-ops unless DEMO=1
//   api        recorded client for the Fintary API, signed in (authentication: Bearer <ID token>, accountid)
//   publicApi  recorded client for the Fintary API, no auth (api/healthcheck, ...)
//   apiFor     apiFor(baseURL, { headers, auth }) -> recorded client for anything else
//
// test    = no session: public pages (/sign-in, /debug).
// appTest = test with a session: the context opens signed in to the web app, on
//           E2E_ACCOUNT_ID when set (localStorage selectedAccount, as the app does).
// The session is a storageState WITH IndexedDB (where Firebase keeps the user),
// made once by lib/firebase.cjs and reused while its refresh token works.
import fs from 'node:fs'
import { test as base, expect, request as pwRequest, type Page, type TestInfo } from '@playwright/test'
import { active, demoApi, Narrator, patchLocator } from './demo'
import { evidenceApi, expandForCapture, hideOverlay, restoreAfterCapture, runAudit, showOverlay, type LayoutCheck, type SnapOptions } from './evidence'
import { recordingClient, FULL, type ApiCall, type RecordingClient } from './api'

/* eslint-disable @typescript-eslint/no-var-requires */
const cfg = require('../lib/config.cjs')
const firebase = require('../lib/firebase.cjs')

const DEMO = !!process.env.DEMO
const MULTI = !!(process.env.E2E_DEVICES || process.env.E2E_BROWSERS)
const GUARD = new RegExp(`^https://(${cfg.writeGuardHosts().map((h: string) => h.replace(/\./g, '\\.')).join('|')})/`)

/** The headers the API needs on a signed-in call. */
async function authHeaders (env: any): Promise<Record<string, string>> {
  await firebase.ensureSession(env)
  return { authentication: `Bearer ${await firebase.idToken(env)}`, ...(env.accountId ? { accountid: env.accountId } : {}) }
}

// ---------------------------------------------------------------------------
// Narrated steps: every top-level test.step gets a numbered caption.
let currentStepTitle: string | null = null

type Fixtures = {
  asUser: boolean
  ftEnv: any
  app: {
    env: any
    accountId: string
    url: (route?: string) => string
  }
  evidence: { snap: (name: string, opts?: SnapOptions) => Promise<string> }
  demo: ReturnType<typeof demoApi>
  _apiLog: ApiCall[]
  api: RecordingClient
  publicApi: RecordingClient
  apiFor: (baseURL: string, o?: { headers?: Record<string, string>, auth?: boolean }) => Promise<RecordingClient>
  _layout: LayoutCheck[]
}

export const test = base.extend<Fixtures>({
  asUser: [false, { option: true }],

  ftEnv: async ({}, use) => { await use(cfg.envConfig(process.env.ENV || cfg.registry().default)) },

  storageState: async ({ storageState, asUser, ftEnv }, use) => {
    await use(asUser ? await firebase.ensureSession(ftEnv) : storageState)
  },

  app: async ({ ftEnv }, use) => {
    await use({
      env: ftEnv,
      accountId: ftEnv.accountId,
      url: (route?: string) => cfg.webUrl(ftEnv, route),
    })
  },

  _layout: async ({}, use) => { await use([]) },

  page: async ({ page, context, _layout, asUser, ftEnv }, use, testInfo) => {
    // preview and prod share the production database: every context aborts
    // non-GET calls to their APIs, whatever page asked for them.
    await context.route(GUARD, (route) => {
      const m = route.request().method()
      if (m === 'GET' || m === 'OPTIONS' || m === 'HEAD') return route.continue()
      testInfo.annotations.push({ type: 'blocked', description: `${m} ${route.request().url().split('?')[0]} (production write guard)` })
      return route.abort('blockedbyclient')
    })

    // The account the app opens on, the way the app stores the user's choice.
    if (asUser && ftEnv.accountId) {
      await context.addInitScript((id: string) => {
        try { window.localStorage.setItem('selectedAccount', JSON.stringify({ accountId: id })) } catch { /* storage blocked */ }
      }, ftEnv.accountId)
    }

    const errors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error' && errors.length < 50) errors.push(msg.text().slice(0, 300)) })
    page.on('pageerror', (err) => { if (errors.length < 50) errors.push(`pageerror: ${String(err.message).slice(0, 300)}`) })

    let narrator: Narrator | null = null
    if (DEMO) {
      patchLocator(page.locator('body'))
      narrator = new Narrator(page, testInfo, testInfo.project.metadata as Record<string, any>)
      active.narrator = narrator
      await narrator.chapter()
    }

    await use(page)

    try {
      if (!page.isClosed()) {
        if (MULTI) {
          // Same full-page capture the audit measures, with the demo narration hidden: it is
          // evidence of the page, not of the recording. Also the only evidence a case that
          // fails before its first snap has.
          const shot = testInfo.outputPath('end-of-test.png')
          await hideOverlay(page)
          await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {})
          if (await expandForCapture(page)) await page.waitForTimeout(400)
          const ok = await page.screenshot({ path: shot, fullPage: true, timeout: 8000 }).then(() => true, () => false)
          const check = await runAudit(page, testInfo, 'end of test', ok ? shot : null)
          await restoreAfterCapture(page)
          await showOverlay(page)
          if (check) _layout.push(check)
          if (ok) await testInfo.attach('end of test', { path: shot, contentType: 'image/png' })
        }
        if (narrator) await narrator.recap()
      }
      if (narrator) await narrator.saveVoice()
    } catch { /* teardown evidence is best-effort */ }
    active.narrator = null
    currentStepTitle = null
    if (_layout.length) await testInfo.attach('layout', { body: JSON.stringify({ checks: _layout }, null, 2), contentType: 'application/json' })
    if (errors.length) await testInfo.attach('console-errors', { body: errors.join('\n'), contentType: 'text/plain' })
  },

  evidence: async ({ page, _layout }, use, testInfo) => {
    const api = evidenceApi(page, testInfo, { layout: _layout, currentStep: () => currentStepTitle, multi: MULTI })
    await use({
      ...api,
      /* In a voiced demo the note is the result, so it is read out once the snap is taken. */
      snap: async (name: string, opts?: SnapOptions) => {
        const out = await api.snap(name, opts)
        if (opts?.note) await active.narrator?.say(opts.note)
        return out
      },
    })
  },

  demo: async ({}, use) => { await use(demoApi()) },

  _apiLog: async ({}, use, testInfo) => {
    const log: ApiCall[] = []
    await use(log)
    if (log.length) await testInfo.attach('api-calls', { body: JSON.stringify({ cleaned: !FULL, calls: log }, null, 2), contentType: 'application/json' })
  },

  api: async ({ ftEnv, _apiLog }, use) => {
    const headers = await authHeaders(ftEnv)
    const ctx = await pwRequest.newContext({ baseURL: ftEnv.apiURL, ignoreHTTPSErrors: true, extraHTTPHeaders: headers })
    await use(recordingClient(ctx, ftEnv.apiURL, _apiLog, 'authentication', ftEnv.accountId ? { accountid: ftEnv.accountId } : {}))
    await ctx.dispose()
  },

  publicApi: async ({ ftEnv, _apiLog }, use) => {
    const ctx = await pwRequest.newContext({ baseURL: ftEnv.apiURL, ignoreHTTPSErrors: true })
    await use(recordingClient(ctx, ftEnv.apiURL, _apiLog))
    await ctx.dispose()
  },

  apiFor: async ({ ftEnv, _apiLog }, use) => {
    const made: { dispose: () => Promise<void> }[] = []
    await use(async (baseURL, o = {}) => {
      const headers = { ...(o.auth ? await authHeaders(ftEnv) : {}), ...(o.headers ?? {}) }
      const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, extraHTTPHeaders: headers })
      made.push(ctx)
      return recordingClient(ctx, baseURL, _apiLog, o.auth ? 'authentication' : undefined, o.auth && ftEnv.accountId ? { accountid: ftEnv.accountId } : {})
    })
    for (const c of made) await c.dispose()
  },
})

// Numbered, narrated steps. Only top-level steps are numbered; nested ones run untouched.
let depth = 0
function narrateSteps<T extends { step: any }> (t: T): T {
  const origStep = t.step.bind(t)
  ;(t as any).step = async function step<R> (title: string, body: (...a: any[]) => Promise<R> | R, options?: any): Promise<R> {
    if (depth > 0) return origStep(title, body, options)
    depth++
    currentStepTitle = title
    try {
      const n = active.narrator
      if (!n) return await origStep(title, body, options)
      return await n.step(title, () => origStep(title, body, options) as Promise<R>)
    } finally {
      depth--
    }
  }
  return t
}
narrateSteps(test)

export const appTest = narrateSteps(test.extend({ asUser: [true, { option: true }] }))

export { expect }
export type { Page, TestInfo }

/** Read a fixture file next to a spec (data JSON, HTML) without caring about cwd. */
export function readNear (testInfo: TestInfo, file: string) {
  return fs.readFileSync(new URL(file, `file://${testInfo.file}`), 'utf-8')
}
