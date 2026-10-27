// Reads the API evidence the harness's `api` / `publicApi` / `apiFor` fixtures record per test
// (the `api-calls` attachment). The data was cleaned when it was recorded --
// secrets redacted, PII masked, bodies truncated unless E2E_API_FULL=1 -- so
// this only reads it back; it never sees raw responses.
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_ENV, knownEnv } from '../env.mjs'
import { resolveRunDir } from './runs.mjs'

function decode (attachment) {
  if (attachment.path && fs.existsSync(attachment.path)) return JSON.parse(fs.readFileSync(attachment.path, 'utf-8'))
  if (attachment.body) return JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf-8'))
  return null
}

/**
 * @param {{ ticket: string, env?: string, test?: string, withBodies?: boolean }} opts
 *   test: case-insensitive substring of a test title, to narrow the output.
 *   withBodies: include request/response bodies and curl (default: summary rows only).
 */
export function apiCalls ({ ticket, env: envName = DEFAULT_ENV, run, test, withBodies = false }) {
  const env = knownEnv(envName)
  if (!env?.evidenceDir) return { ok: false, error: `Environment "${envName}" records no evidence.` }
  const dir = resolveRunDir(env, ticket, run)
  const resultsFile = dir && path.join(dir, 'results.json')
  if (!resultsFile || !fs.existsSync(resultsFile)) return { ok: false, error: `No run${run ? ` "${run}"` : ''} recorded for ${ticket} on ${env.name}.` }

  const data = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'))
  const tests = []
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1]
        const att = last?.attachments?.find(a => a.name === 'api-calls')
        if (!att) continue
        if (test && !spec.title.toLowerCase().includes(test.toLowerCase())) continue
        const log = decode(att)
        if (!log) continue
        tests.push({
          title: spec.title,
          project: t.projectName,
          status: last.status,
          cleaned: log.cleaned,
          calls: log.calls.map(c => (withBodies ? c : {
            n: c.n, method: c.method, path: c.path, status: c.status, ms: c.ms, ...(c.error ? { error: c.error } : {}),
          })),
        })
      }
    }
    for (const child of suite.suites ?? []) walk(child)
  }
  for (const suite of data.suites ?? []) walk(suite)

  const all = tests.flatMap(t => t.calls)
  return {
    ok: true,
    ticket,
    env: env.name,
    run: path.basename(dir),
    testsWithCalls: tests.length,
    totalCalls: all.length,
    failedCalls: all.filter(c => c.status === null || c.status >= 400).length,
    anyFullBodies: tests.some(t => t.cleaned === false),
    tests,
    ...(tests.length ? {} : { note: 'No API calls recorded. Specs record them by using the `api`, `publicApi` or `apiFor` fixture.' }),
  }
}
