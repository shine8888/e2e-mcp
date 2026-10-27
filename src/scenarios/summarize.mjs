// THE reducer. Every consumer -- the run scenario, the report roll-up, the
// get_evidence tool, the CLI -- summarizes a Playwright run through this file
// and nothing else, so "what counts as a pass" can never drift between the
// surfaces that report it.
import fs from 'node:fs'

/**
 * Reads one Playwright JSON-reporter file into a flat summary.
 *
 * Playwright already computes per-test status ('expected' | 'unexpected' |
 * 'flaky' | 'skipped') and top-level stats; this does not recompute either, it
 * only walks the suite tree to recover the TITLES behind the counts.
 *
 * `incomplete` matters: a run killed mid-flight leaves its unreached tests
 * marked skipped. Counting only expected/(expected+unexpected) would then read
 * a half-finished run as 100%. A run with skips and no explicit skip in the
 * spec is flagged so a caller never reports it as clean.
 * @param {string} resultsJsonPath
 */
export function summarizeRun (resultsJsonPath) {
  const data = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf-8'))
  const stats = data.stats ?? {}
  const failing = []
  const flaky = []
  const skipped = []

  const walk = (suite, trail) => {
    for (const spec of suite.specs ?? []) {
      const title = [...trail, spec.title].filter(Boolean).join(' › ')
      for (const test of spec.tests ?? []) {
        const row = { title, project: test.projectName }
        if (test.status === 'unexpected') failing.push(row)
        else if (test.status === 'flaky') flaky.push(row)
        else if (test.status === 'skipped') skipped.push(row)
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...trail, child.title])
  }
  for (const suite of data.suites ?? []) walk(suite, [suite.title])

  const expected = stats.expected ?? 0
  const unexpected = stats.unexpected ?? 0
  const flakyCount = stats.flaky ?? 0
  const skippedCount = stats.skipped ?? 0
  const ran = expected + unexpected + flakyCount
  const denominator = ran + skippedCount

  return {
    startTime: stats.startTime ?? null,
    durationMs: stats.duration ?? null,
    expected,
    unexpected,
    flaky: flakyCount,
    skipped: skippedCount,
    total: denominator,
    // Pass rate counts skips in the denominator on purpose: a run that skipped
    // half its cases did not pass half of them, it just never asked.
    passRate: denominator === 0 ? null : Number((expected / denominator).toFixed(4)),
    passed: unexpected === 0 && ran > 0,
    incomplete: skippedCount > 0,
    failingTests: failing,
    flakyTests: flaky,
    skippedTests: skipped,
    errors: (data.errors ?? []).map(e => e.message ?? String(e)).slice(0, 10),
  }
}

/** One-line human summary, used by the CLI, the MCP tools and the roll-up alike. */
export function oneLine (summary) {
  if (!summary) return 'no run recorded'
  const bits = [`${summary.expected} passed`]
  if (summary.unexpected) bits.push(`${summary.unexpected} FAILED`)
  if (summary.flaky) bits.push(`${summary.flaky} flaky`)
  if (summary.skipped) bits.push(`${summary.skipped} skipped`)
  const pct = summary.passRate === null ? 'n/a' : `${Math.round(summary.passRate * 100)}%`
  return `${bits.join(', ')} (${pct})`
}

/**
 * Target pass rate: 95%. Kept here (not in each renderer) so the CLI, the HTML
 * report and any MCP caller cannot disagree about what "healthy" means.
 */
export const PASS_RATE_TARGET = 0.95

/**
 * 'good' | 'warn' | 'bad' for a summary or a roll-up total.
 *
 * A run with skips is never 'good', however few things failed: skipped cases
 * are unproven, not passed, and a half-finished run that reads green is the
 * failure mode this whole reducer exists to prevent.
 */
export function verdictOf ({ unexpected = 0, skipped = 0, passRate = null } = {}) {
  if (unexpected > 0) return 'bad'
  if (passRate !== null && passRate < PASS_RATE_TARGET) return 'warn'
  if (skipped > 0) return 'warn'
  return 'good'
}
