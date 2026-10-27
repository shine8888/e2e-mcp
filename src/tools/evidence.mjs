// Reads what is already on disk: a ticket's last run and the ticket list.
// Summaries come from the one shared reducer (scenarios/summarize.mjs), never
// from a second copy of the pass/fail rule.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { errorResult, FT_E2E_DIR, textResult } from '../ft-e2e.mjs'
import { DEFAULT_ENV, ENVIRONMENTS, ENV_NAMES, knownEnv } from '../env.mjs'
import { summarizeRun, oneLine } from '../scenarios/summarize.mjs'
import { apiCalls } from '../scenarios/api-calls.mjs'
import { listRuns, resolveRunDir } from '../scenarios/runs.mjs'

const envEnum = z.enum(ENV_NAMES)

const runParam = z.string().optional()
  .describe('A run id from list_runs (e.g. "2026-09-28_17-58-03"). Omit for the newest run.')

export function registerEvidenceTools (server) {
  server.registerTool('get_evidence', {
    title: 'Get a ticket\'s last run',
    description: 'Reads the LAST recorded run for a ticket without running anything: counts, '
      + 'failing and flaky test titles, the EVIDENCE.md notes, and the command to open the full '
      + 'HTML report.',
    inputSchema: {
      ticket: z.string().describe('Ticket folder under harness/tickets, e.g. "PLT-1234", or "adhoc".'),
      env: envEnum.default(DEFAULT_ENV),
      run: runParam,
      includeNotes: z.boolean().default(true).describe('Include the full EVIDENCE.md body (long).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ ticket, env, run, includeNotes }) => {
    const envRec = knownEnv(env)
    if (!envRec?.evidenceDir) return errorResult(`Environment "${env}" records no evidence (it is declared but not wired for runs).`)
    const dir = resolveRunDir(envRec, ticket, run)
    if (!dir) {
      return errorResult(`No ${run ? `run "${run}"` : 'run'} recorded for ${ticket} on ${env}. `
        + (run ? 'Use list_runs for the ids that exist.' : 'Use run_e2e to create one.'))
    }
    const resultsFile = path.join(dir, 'results.json')
    const summary = summarizeRun(resultsFile)
    const notesPath = path.join(dir, 'EVIDENCE.md')
    return textResult(JSON.stringify({
      ticket,
      env,
      run: path.basename(dir) === (envRec.evidenceDir) ? 'legacy' : path.basename(dir),
      runsRecorded: listRuns(envRec, ticket).length,
      headline: oneLine(summary),
      summary,
      reportOpenCommand: `cd ${FT_E2E_DIR} && npx playwright show-report ${path.relative(FT_E2E_DIR, path.join(dir, 'report'))}`,
      evidenceNotes: includeNotes && fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf-8') : null,
      evidenceNotesPath: fs.existsSync(notesPath) ? notesPath : null,
    }, null, 2))
  })

  server.registerTool('get_api_calls', {
    title: 'Get a run\'s recorded API calls',
    description: 'Every API call a ticket\'s last run made through the api / publicApi / apiFor fixtures: method, '
      + 'path, status and timing per test, and with withBodies the request body, response body, '
      + 'backend request id and a replayable curl line. Already cleaned at record time -- secrets '
      + 'redacted, emails/phones masked, bodies truncated (anyFullBodies flags a run made with '
      + 'E2E_API_FULL=1, which must not be shared). Read-only.',
    inputSchema: {
      ticket: z.string(),
      env: envEnum.default(DEFAULT_ENV),
      run: runParam,
      test: z.string().optional().describe('Case-insensitive part of a test title, to narrow the output.'),
      withBodies: z.boolean().default(false).describe('Include bodies and curl, not just the summary rows.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => {
    const res = apiCalls(args)
    return res.ok ? textResult(JSON.stringify(res, null, 2)) : errorResult(res.error)
  })

  server.registerTool('list_runs', {
    title: 'List every recorded run of a ticket',
    description: 'Every run of a ticket on one environment, newest first, each in its own '
      + 'date-time folder (runs/<YYYY-MM-DD_HH-MM-SS>) that later runs never overwrite: result, '
      + 'counts, duration, and whether it has EVIDENCE.md, a report.webm video and API calls. Pass an id '
      + 'as `run` to get_evidence / list_videos / build_demo_video / get_api_calls. "legacy" is a '
      + 'run from before per-run folders existed.',
    inputSchema: { ticket: z.string(), env: envEnum.default(DEFAULT_ENV) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ ticket, env }) => {
    const envRec = knownEnv(env)
    if (!envRec?.evidenceDir) return errorResult(`Environment "${env}" records no evidence.`)
    const runs = listRuns(envRec, ticket).reverse().map((r) => {
      const s = summarizeRun(path.join(r.dir, 'results.json'))
      const has = f => fs.existsSync(path.join(r.dir, f))
      return {
        run: r.id,
        headline: oneLine(s),
        passed: s.passed,
        incomplete: s.incomplete,
        startTime: s.startTime,
        durationSec: s.durationMs ? Math.round(s.durationMs / 1000) : null,
        evidenceMd: has('EVIDENCE.md') ? path.join(r.dir, 'EVIDENCE.md') : null,
        // report.webm since 2026-09-29; earlier runs have demo.webm.
        video: has('report.webm') ? path.join(r.dir, 'report.webm') : (has('demo.webm') ? path.join(r.dir, 'demo.webm') : null),
      }
    })
    if (!runs.length) return errorResult(`No runs recorded for ${ticket} on ${env}.`)
    return textResult(JSON.stringify({ ticket, env, count: runs.length, runs }, null, 2))
  })

  server.registerTool('list_tickets', {
    title: 'List tickets and their last runs',
    description: 'Lists ticket folders under harness/tickets with a one-line result per '
      + 'environment, so you know what get_evidence will return before calling it.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const ticketsDir = path.join(FT_E2E_DIR, 'tickets')
    if (!fs.existsSync(ticketsDir)) return errorResult(`No tickets/ directory at ${ticketsDir}`)
    const rows = fs.readdirSync(ticketsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map(e => e.name)
      .sort()
      .map((ticket) => {
        const runs = {}
        for (const env of ENVIRONMENTS.filter(x => x.wired)) {
          const all = listRuns(env, ticket)
          if (!all.length) continue
          const file = path.join(all.at(-1).dir, 'results.json')
          try {
            const summary = summarizeRun(file)
            runs[env.name] = {
              headline: oneLine(summary), passed: summary.passed, startTime: summary.startTime,
              latestRun: all.at(-1).id, runsRecorded: all.length,
            }
          } catch (err) {
            runs[env.name] = { error: err.message }
          }
        }
        return { ticket, runs }
      })
    return textResult(JSON.stringify(rows, null, 2))
  })
}
