// Wraps harness/scripts/inspect.mjs -- selector reconnaissance against a LIVE
// page. This is the tool to reach for before writing a locator: it dumps what
// is actually in the DOM instead of guessing.
import { z } from 'zod'
import { DEFAULT_ENV, ENV_NAMES } from '../env.mjs'
import { errorResult, runInHarness, textResult } from '../ft-e2e.mjs'

export function registerInspectTool (server) {
  server.registerTool('inspect_page', {
    title: 'Inspect a live page for selectors',
    description: 'Opens a page of the Fintary web app and returns the handles actually in the DOM: headings, '
      + 'buttons (accessible names), inputs (id / label / name -- the app puts ids on inputs, e.g. #emailAddress), '
      + 'tabs, dialogs, MUI DataGrid column headers and row counts, links, tables, aria-labels, iframes, any '
      + 'data-testid (sparse: about 48 in the app, e.g. [data-testid="user-menu-button"]), and the Mui* component '
      + 'classes with counts -- plus console errors and a full-page screenshot under tickets/_inspect/. Prefer '
      + 'getByRole / getByLabel / #id. Use this BEFORE writing a locator; never guess a selector. route is a web '
      + 'path, e.g. "/policies", "/agents/list", "/settings/general", or a full https URL. Signed in by default with '
      + 'the cached session (signs in first when it is dead; needs the test user in harness/.env.<env>), on '
      + 'account (or E2E_ACCOUNT_ID); public routes (/sign-in, /debug, /reset) and public:true open without a '
      + 'session. Read-only: non-GET calls to the preview and production APIs are blocked.',
    inputSchema: {
      route: z.string().default('/').describe('Web path, e.g. "/policies", or a full https URL.'),
      env: z.enum(ENV_NAMES).default(DEFAULT_ENV),
      account: z.string().optional().describe('Account str_id to open on (localStorage selectedAccount). Default: E2E_ACCOUNT_ID, else the user\'s default.'),
      public: z.boolean().default(false).describe('Open without a session.'),
      waitMs: z.number().int().nonnegative().default(6000).describe('Extra settle time after load before reading the DOM.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ route, env, account, public: pub, waitMs }) => {
    const args = ['scripts/inspect.mjs', route || '/', '--env', env, '--wait', String(waitMs)]
    if (account) args.push('--account', account)
    if (pub) args.push('--public')
    // networkidle is capped at 15s inside inspect.mjs (the app polls), plus a possible sign-in.
    const res = await runInHarness('node', args, { timeoutMs: waitMs + 180_000, extraEnv: { ENV: env } })
    if (res.timedOut) return errorResult(`inspect.mjs timed out.\n${res.stderr}`)
    if (res.code !== 0) return errorResult(`inspect.mjs exited ${res.code}:\n${res.stderr || res.stdout}`)
    try {
      const report = JSON.parse(res.stdout)
      return textResult(JSON.stringify(report, null, 2))
    } catch {
      return errorResult(`inspect.mjs did not print valid JSON:\n${res.stdout}\n${res.stderr}`)
    }
  })
}
