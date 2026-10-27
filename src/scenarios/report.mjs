// Cross-ticket, cross-environment roll-up. The harness already builds a per-ticket
// EVIDENCE.md (scripts/build-report.mjs); nothing there answers "how is the
// whole suite doing, per environment". This does, reading every recorded run
// through the one shared reducer so it can never disagree with what the run
// scenario or the MCP tools reported for the same file.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FT_E2E_DIR } from '../ft-e2e.mjs'
import { ENVIRONMENTS } from '../env.mjs'
import { summarizeRun, oneLine, verdictOf } from './summarize.mjs'
import { listRuns } from './runs.mjs'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function ticketNames () {
  const dir = path.join(FT_E2E_DIR, 'tickets')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
    .map(e => e.name)
    .sort()
}

/** Every recorded run: one row per (ticket, wired environment) that has results. */
export function collectRuns () {
  const rows = []
  for (const ticket of ticketNames()) {
    for (const env of ENVIRONMENTS.filter(e => e.wired)) {
      // The newest run per ticket/env; older runs stay on disk for list_runs.
      const runs = listRuns(env, ticket)
      if (!runs.length) continue
      const latest = runs.at(-1)
      const file = path.join(latest.dir, 'results.json')
      try {
        const summary = summarizeRun(file)
        rows.push({
          ticket,
          env: env.name,
          envLabel: env.label,
          summary,
          headline: oneLine(summary),
          run: latest.id,
          runCount: runs.length,
          evidencePath: latest.dir,
          hasEvidenceMd: fs.existsSync(path.join(latest.dir, 'EVIDENCE.md')),
        })
      } catch (err) {
        rows.push({ ticket, env: env.name, envLabel: env.label, error: err.message })
      }
    }
  }
  return rows
}

/** Per-environment totals across every ticket that has a run there. */
export function rollUp (rows) {
  const byEnv = new Map()
  for (const row of rows) {
    if (!row.summary) continue
    const acc = byEnv.get(row.env) ?? {
      env: row.env, label: row.envLabel, tickets: 0, expected: 0, unexpected: 0, flaky: 0, skipped: 0, incomplete: 0, latest: null,
    }
    acc.tickets += 1
    acc.expected += row.summary.expected
    acc.unexpected += row.summary.unexpected
    acc.flaky += row.summary.flaky
    acc.skipped += row.summary.skipped
    if (row.summary.incomplete) acc.incomplete += 1
    if (row.summary.startTime && (!acc.latest || row.summary.startTime > acc.latest)) acc.latest = row.summary.startTime
    byEnv.set(row.env, acc)
  }
  for (const acc of byEnv.values()) {
    const denom = acc.expected + acc.unexpected + acc.flaky + acc.skipped
    acc.total = denom
    acc.passRate = denom === 0 ? null : Number((acc.expected / denom).toFixed(4))
  }
  // Registry order, so the report reads local -> dev -> uat the same way every time.
  return ENVIRONMENTS.map(e => byEnv.get(e.name)).filter(Boolean)
}

const pct = v => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}%`)
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

function toMarkdown (rows, totals, generatedAt) {
  const lines = [
    '# Fintary e2e run report',
    '',
    `Generated ${generatedAt} · source: \`${FT_E2E_DIR}\``,
    '',
    '## By environment',
    '',
    '| Environment | Tickets | Passed | Failed | Flaky | Skipped | Pass rate | Latest run |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
  ]
  for (const t of totals) {
    lines.push(`| ${t.label} | ${t.tickets} | ${t.expected} | ${t.unexpected} | ${t.flaky} | ${t.skipped} | ${pct(t.passRate)} | ${t.latest ?? '—'} |`)
  }
  lines.push('', '## By ticket', '', '| Ticket | Environment | Result | Started | Evidence |', '|---|---|---|---|---|')
  for (const r of rows) {
    if (r.error) { lines.push(`| ${r.ticket} | ${r.envLabel} | unreadable: ${r.error} | — | — |`); continue }
    const flag = r.summary.passed ? 'PASS' : 'FAIL'
    const incomplete = r.summary.incomplete ? ' *(incomplete — some cases never ran)*' : ''
    lines.push(`| ${r.ticket} | ${r.envLabel} | **${flag}** ${r.headline}${incomplete} | ${r.summary.startTime ?? '—'} | ${r.hasEvidenceMd ? `\`${path.relative(FT_E2E_DIR, r.evidencePath)}/EVIDENCE.md\`` : '—'} |`)
  }
  const failing = rows.filter(r => r.summary && r.summary.failingTests.length)
  if (failing.length) {
    lines.push('', '## Failing cases', '')
    for (const r of failing) {
      lines.push(`### ${r.ticket} — ${r.envLabel}`, '')
      for (const t of r.summary.failingTests) lines.push(`- ${t.title} _(${t.project})_`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

function toHtml (rows, totals, generatedAt) {
  // Pass-rate bars are banded 80-100%, not 0-100%: on a suite that lives in the
  // nineties a 0-100 bar makes 95% and 100% look identical, which is exactly
  // the regression you need to see.
  const band = v => (v === null ? 0 : Math.max(0, Math.min(100, (v * 100 - 80) * 5)))
  const cards = totals.map(t => `
    <div class="card">
      <h3>${esc(t.label)}</h3>
      <div class="rate ${verdictOf(t)}">${pct(t.passRate)}</div>
      <div class="bar"><span style="width:${band(t.passRate)}%"></span></div>
      <dl>
        <div><dt>Tickets</dt><dd>${t.tickets}</dd></div>
        <div><dt>Passed</dt><dd>${t.expected}</dd></div>
        <div><dt>Failed</dt><dd>${t.unexpected}</dd></div>
        <div><dt>Flaky</dt><dd>${t.flaky}</dd></div>
        <div><dt>Skipped</dt><dd>${t.skipped}</dd></div>
      </dl>
      <p class="latest">Latest: ${esc(t.latest ?? '—')}</p>
      ${t.incomplete ? `<p class="warn">${t.incomplete} incomplete run(s) — cases that never ran are counted against the rate.</p>` : ''}
    </div>`).join('')

  const trs = rows.map((r) => {
    if (r.error) return `<tr><td>${esc(r.ticket)}</td><td>${esc(r.envLabel)}</td><td colspan="3" class="bad">unreadable: ${esc(r.error)}</td></tr>`
    return `<tr>
      <td>${esc(r.ticket)}</td>
      <td>${esc(r.envLabel)}</td>
      <td class="${verdictOf(r.summary)}">${r.summary.passed ? 'PASS' : 'FAIL'}</td>
      <td>${esc(r.headline)}${r.summary.incomplete ? ' <em>(incomplete)</em>' : ''}</td>
      <td>${esc(r.summary.startTime ?? '—')}</td>
    </tr>`
  }).join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fintary e2e report</title>
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --muted:#666; --line:#ddd; --good:#137333; --bad:#c5221f; --warnc:#b06000; --bg:#fff; --card:#fafafa; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --muted:#9aa0a6; --line:#3c4043; --good:#81c995; --bad:#f28b82; --warnc:#fdd663; --bg:#1a1a1a; --card:#242424; } }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 32px; color: var(--fg); background: var(--bg); }
  h1 { margin: 0 0 4px; font-size: 22px; } .sub { color: var(--muted); margin: 0 0 28px; }
  .cards { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 32px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 20px; min-width: 210px; }
  .card h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .rate { font-size: 30px; font-weight: 600; } .good { color: var(--good); } .bad { color: var(--bad); } .warn { color: var(--warnc); }
  .bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; margin: 10px 0 12px; }
  .bar span { display: block; height: 100%; background: currentColor; }
  dl { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; }
  dl div { display: flex; justify-content: space-between; } dt { color: var(--muted); } dd { margin: 0; font-variant-numeric: tabular-nums; }
  .latest, .warn { color: var(--muted); font-size: 12px; margin: 10px 0 0; } .warn { color: var(--bad); }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .wrap { overflow-x: auto; }
</style></head><body>
<h1>Fintary e2e run report</h1>
<p class="sub">Generated ${esc(generatedAt)} · ${esc(FT_E2E_DIR)}</p>
<div class="cards">${cards || '<p>No recorded runs.</p>'}</div>
<h2>By ticket</h2>
<div class="wrap"><table><thead><tr><th>Ticket</th><th>Environment</th><th>Result</th><th>Detail</th><th>Started</th></tr></thead>
<tbody>${trs || '<tr><td colspan="5">No recorded runs.</td></tr>'}</tbody></table></div>
</body></html>`
}

/**
 * @param {{ outDir?: string, formats?: ('md'|'html'|'json')[] }} opts
 */
export async function report ({ outDir, formats = ['md', 'html', 'json'] } = {}) {
  const rows = collectRuns()
  const totals = rollUp(rows)
  const generatedAt = new Date().toISOString()
  const dir = outDir ?? path.join(PROJECT_ROOT, 'reports')
  fs.mkdirSync(dir, { recursive: true })

  const written = []
  const write = (name, body) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, body)
    written.push(file)
  }
  if (formats.includes('md')) write('latest.md', toMarkdown(rows, totals, generatedAt))
  if (formats.includes('html')) write('latest.html', toHtml(rows, totals, generatedAt))
  if (formats.includes('json')) write('latest.json', JSON.stringify({ generatedAt, totals, rows }, null, 2))

  return {
    ok: true,
    generatedAt,
    runsFound: rows.length,
    totals,
    written,
    markdown: toMarkdown(rows, totals, generatedAt),
  }
}
