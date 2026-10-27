// Wraps harness/scripts/dev-up.sh, which in turn calls the fintary repo's own
// scripts/agent/{up,down}.sh -- the one place that knows how to start/check/stop
// the local Fintary stack (Postgres, auth emulator, API, web). This file adds no
// logic of its own beyond shaping the output.
import { z } from 'zod'
import { errorResult, runInHarness, textResult } from '../ft-e2e.mjs'

export function registerDevStackTools (server) {
  server.registerTool('dev_stack_status', {
    title: 'Dev stack status',
    description: 'Reports whether the local Fintary stack is up: web :3001 (Vite), API :3000 (/api/healthcheck), '
      + 'Postgres :5431 (docker local-psql) and the auth emulator :4002 -- and warns when something listens on '
      + ':5432 (the production database proxy; never stop it, never use it). Read-only -- runs `dev-up.sh --status`. '
      + 'Run it before inspect_page or run_e2e with env=local.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const res = await runInHarness('bash', ['scripts/dev-up.sh', '--status'], { timeoutMs: 30_000 })
    return textResult(res.stdout || res.stderr || '(no output)')
  })

  server.registerTool('dev_stack_up', {
    title: 'Start the dev stack',
    description: 'Starts the local Fintary stack with the repo\'s own scripts/agent/up.sh: Postgres (Docker, :5431) '
      + 'with migrations and seed, the Firebase auth emulator (:4002), the API (:3000) and the web (:3001) in '
      + 'emulator mode, then seeds a Fintary admin (<seeded-admin-email>, uid <seeded-admin-uid>, Account Admin on '
      + 'the seeded account) -- sign in as it with E2E_EMULATOR=1, E2E_UID=<seeded-admin-uid> and '
      + 'E2E_EMAIL=<seeded-admin-email> in harness/.env.local. Idempotent. Needs Docker Desktop running and the '
      + 'first-time scripts/agent/setup.sh done; both come back as manual steps. Blocks until ready or timeout.',
    inputSchema: {
      timeoutMs: z.number().int().positive().optional().describe('Override the default 10-minute timeout for a cold first start.'),
    },
  }, async ({ timeoutMs }) => {
    const budget = timeoutMs ?? 600_000
    const res = await runInHarness('bash', ['scripts/dev-up.sh', '--up'], { timeoutMs: budget })
    const out = (res.stdout || '') + (res.stderr ? `\n--- stderr ---\n${res.stderr}` : '')
    if (res.timedOut) {
      return errorResult(`scripts/agent/up.sh did not finish within the timeout. Output so far:\n\n${out.slice(-6000)}`)
    }
    return res.code === 0 ? textResult(out.slice(-6000) || '(no output)') : errorResult(out.slice(-6000) || `dev-up.sh exited ${res.code}`)
  })

  server.registerTool('dev_stack_down', {
    title: 'Stop the dev stack',
    description: 'Stops what scripts/agent/up.sh started (the repo\'s scripts/agent/down.sh: by its PID files, so '
      + 'unrelated processes on the same ports are never touched). Keeps the database volume.',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async () => {
    const res = await runInHarness('bash', ['scripts/dev-up.sh', '--stop'], { timeoutMs: 60_000 })
    return textResult(res.stdout || res.stderr || '(no output)')
  })
}
