// MCP surface for the scenarios. Thin on purpose: every one of these is the
// same function bin/ft-e2e-run.mjs calls, so the CLI and the MCP server can
// never drift into behaving differently.
import { z } from 'zod'
import { DEFAULT_ENV, ENVIRONMENTS, ENV_NAMES } from '../env.mjs'
import { preflight } from '../scenarios/preflight.mjs'
import { prepare } from '../scenarios/prepare.mjs'
import { run } from '../scenarios/run.mjs'
import { report } from '../scenarios/report.mjs'
import { BROWSER_NAMES, DEVICE_GROUP_NAMES, DEVICE_NAMES } from '../scenarios/devices.mjs'

const envEnum = z.enum(ENV_NAMES)
const wired = ENVIRONMENTS.filter(e => e.wired).map(e => e.name).join(', ')
const declared = ENVIRONMENTS.filter(e => !e.wired).map(e => e.name).join(', ')

const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const fail = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: true })

export function registerScenarioTools (server) {
  server.registerTool('list_environments', {
    title: 'List target environments',
    description: `The environment registry: which environments exist, their origins, and which `
      + `can actually host a test run. Wired for runs: ${wired}. Declared but not wired `
      + `(reachability checks only): ${declared}.`,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => json(ENVIRONMENTS))

  server.registerTool('preflight', {
    title: 'Pre-run readiness check',
    description: 'Read-only gate run BEFORE a suite: the ft-e2e harness and its dependencies, the web app '
      + '(/sign-in) and the API (GET /api/healthcheck: status and the commit its image was built from), the live '
      + 'web build time (/manifest.json versionInfo.buildTime -- a merged change is only there once its deploy ran), '
      + 'the test user (harness/.env.<env>, never read out) and whether the cached Firebase session still refreshes, '
      + 'and on local: Postgres :5431, the auth emulator when E2E_EMULATOR=1, a warning when something listens on '
      + ':5432 (the production database proxy), and the fintary repo\'s own SKILLS/run-app safety preflight. Login '
      + 'checks block only for tickets with signed-in specs (appTest / api / auth:true). preview and prod are probed '
      + 'with GETs only. Changes nothing. Branch on `canRun`: `ok` only means nothing checked is broken, while '
      + '`canRun` also requires the environment to be wired for runs (local, dev, uat).',
    inputSchema: {
      env: envEnum.default(DEFAULT_ENV),
      ticket: z.string().optional().describe('Also check that tests/<ticket> exists, and whether it needs a signed-in user.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ env, ticket }) => {
    const res = await preflight({ env, ticket })
    return res.ok ? json(res) : fail(res)
  })

  server.registerTool('prepare', {
    title: 'Prepare an environment for a run',
    description: 'Fixes what can be fixed safely: installs the harness dependencies if missing; on local, '
      + 'starts the stack through the repo\'s scripts/agent/up.sh (Postgres + migrations, auth emulator, API, web, '
      + 'and the seeded admin <seeded-admin-email>) unless web and API already answer; signs the test user in '
      + 'when the cached session is dead. Deliberately does NOT open Docker Desktop, run the first-time '
      + 'scripts/agent/setup.sh, copy credentials (never from the repo\'s env files) or touch :5432 -- those come '
      + 'back in `manual`. Ends by re-running preflight so the result shows the final state.',
    inputSchema: {
      env: envEnum.default(DEFAULT_ENV),
      ticket: z.string().optional(),
      startStack: z.boolean().default(true).describe('Start the local stack (ignored for deployed environments).'),
      signIn: z.boolean().default(true).describe('Sign in again when the cached session is dead and a test user is on file.'),
      timeoutMs: z.number().int().positive().default(600_000),
    },
  }, async (args) => {
    const res = await prepare(args)
    return res.ok ? json(res) : fail(res)
  })

  server.registerTool('run_e2e', {
    title: 'Run an e2e suite',
    description: 'Runs preflight, then the Playwright suite scoped to a ticket (harness/tests/<ticket>) and/or '
      + 'grep, then rebuilds that ticket\'s EVIDENCE.md, and returns one summary. Refuses to run the whole '
      + 'suite unscoped, and refuses environments that are declared but not wired (preview, prod: they share the '
      + 'production database). Defaults to dev and headless. dev and uat are shared: cases tagged @writes (create, '
      + 'change or delete data) are LEFT OUT unless writes:true, and even then belong only on accounts named '
      + '"E2E Test account…" with E2E_-prefixed data. Every context aborts non-GET calls to api.fintary.com and '
      + 'api-preview.fintary.com. Blocks until the run finishes; size timeoutMs for the cases you expect. Every '
      + 'browser test is recorded to video.webm. demo:true narrates the recording at 1600x1000, headed: a chapter '
      + 'card per test; a numbered "Step N" caption and a STEPS checklist per test.step; every click / type / tick / '
      + 'select ringed with an arrow and a plain-English label (passwords masked). Specs add demo.circle / demo.point / '
      + 'demo.callout for results no action touches. With demo, voice (default on, macOS) also reads each test title, step, '
      + 'evidence note and recap aloud, holding the page until each line ends. Follow with build_demo_video to stitch one reel. apiOnly:true '
      + 'runs only *.api.spec.ts with no browser; read the recorded calls with get_api_calls. Every run writes to its '
      + 'own date-time folder (runs/<YYYY-MM-DD_HH-MM-SS>, returned as runId); latest/ points at the newest. A dead '
      + 'session never blocks when a test user is on file: the fixtures sign in again through the web\'s form. '
      + 'devices:["desktop","tablet","mobile"] runs every browser case once per screen, each in its own emulated '
      + 'session, audits every evidence snap for layout breaks, and builds the case x screen report (deviceReport '
      + 'in the result; see build_device_report). Budget timeoutMs for cases x screens.',
    inputSchema: {
      env: envEnum.default(DEFAULT_ENV),
      ticket: z.string().optional().describe('Ticket folder under harness/tests/, e.g. "PLT-1234", or a smoke ticket ("_web-smoke", "_app-smoke", "_demo-smoke", "_api-smoke", "_device-smoke").'),
      grep: z.string().optional().describe('Playwright --grep pattern.'),
      headed: z.boolean().default(false),
      demo: z.boolean().default(false).describe('Narrated full-resolution recording (forces headed).'),
      voice: z.boolean().default(true).describe('With demo: also read the steps and results aloud (macOS `say`; voice from E2E_VOICE_NAME, default Samantha). Ignored without demo.'),
      refreshLogin: z.boolean().default(true).describe('If the session is the ONLY preflight blocker, sign in first (the web\'s form with the env file\'s test user), then run. false = stop and report instead.'),
      apiOnly: z.boolean().default(false).describe('Run only the ticket\'s *.api.spec.ts files: no browser, no video. Every call through the api / publicApi / apiFor fixtures is recorded as cleaned evidence.'),
      skipPreflight: z.boolean().default(false).describe('Run even if preflight reports blockers. Use when you know better than the gate (e.g. the login-free smoke tickets).'),
      buildEvidence: z.boolean().default(true).describe('Rebuild EVIDENCE.md after the run.'),
      devices: z.array(DEVICE_NAMES.length ? z.enum([...DEVICE_NAMES, ...DEVICE_GROUP_NAMES]) : z.string()).default([]).describe('Multi-device run: screens and/or groups, e.g. ["desktop","tablet","mobile"], ["desktop","iphones","android"], ["phones"], ["all"] (list_devices for both lists). Empty = the usual single desktop run.'),
      browsers: z.array(z.enum([...BROWSER_NAMES, 'all', 'webkit', 'msedge'])).default([]).describe('Cross-browser run: chromium (default engine), chrome, edge, firefox, safari, or all (= chromium, firefox, safari). safari = Playwright WebKit (Safari\'s engine, not Safari.app); chrome / edge must be installed or they are skipped and reported. Combines with devices (every screen in every browser).'),
      grepInvert: z.string().optional().describe('Playwright --grep-invert pattern. @writes cases are already left out unless writes:true.'),
      writes: z.boolean().default(false).describe('Also run cases tagged @writes (they create, change or delete data). dev / uat / local only, on an E2E Test account.'),
      layoutStrict: z.boolean().default(false).describe('Device runs: fail a case whose screen scrolls sideways. Default reports layout breaks without failing the case.'),
      timeoutMs: z.number().int().positive().default(600_000),
    },
  }, async (args) => {
    const res = await run(args)
    return res.ok ? json(res) : fail(res)
  })

  server.registerTool('build_report', {
    title: 'Build the cross-ticket run report',
    description: 'Rolls every recorded run up into one report: per-environment pass rates and '
      + 'per-ticket results, written as markdown, HTML and JSON under the server\'s reports/ '
      + 'folder. Reads only what is already on disk -- it runs nothing. Skipped cases count '
      + 'against the pass rate on purpose, so a half-finished run cannot read as clean.',
    inputSchema: {
      outDir: z.string().optional().describe('Where to write. Defaults to <server>/reports.'),
      formats: z.array(z.enum(['md', 'html', 'json'])).default(['md', 'html', 'json']),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async (args) => json(await report(args)))
}
