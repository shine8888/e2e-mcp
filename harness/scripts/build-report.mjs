#!/usr/bin/env node
// EVIDENCE.md for one run, RUNS.md for the ticket's history, and the `latest`
// link -- the run's own record of what was tested, against which commits, and
// what it saw.
//
//   node scripts/build-report.mjs <ticket> <env> [<run id>]      (run id defaults to the newest)
//
// "Systems under test" rows are stamped at build time:
//   local     the fintary checkout's branch @ commit (+ "uncommitted changes" under services/)
//   dev, uat  what is LIVE there: the API's commitSha (GET <api>/api/healthcheck -- the commit
//             its image was built from) and the web's build time (GET <web>/manifest.json
//             versionInfo.buildTime). A merged change is only testable once its deploy ran.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import cfg from '../lib/config.cjs'
import { readRun, decodeAttachment, esc, rel } from './lib/results.mjs'

const [ticket, envName, runArg] = process.argv.slice(2)
if (!ticket || !envName) { console.error('usage: build-report.mjs <ticket> <env> [<run id>]'); process.exit(2) }
const env = cfg.envConfig(envName)
const root = cfg.evidenceRoot(ticket, env)
const runsDir = path.join(root, 'runs')
const runIds = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(id => fs.existsSync(path.join(runsDir, id, 'results.json'))).sort() : []
const runId = runArg ?? runIds.at(-1)
if (!runId) { console.error(`No runs for ${ticket} on ${envName}`); process.exit(1) }
const runDir = path.join(runsDir, runId)

function git (args) {
  return execFileSync('git', args, { cwd: cfg.FINTARY_DIR, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}
async function getJson (url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    return r.ok ? await r.json() : null
  } catch { return null }
}
async function stamps () {
  try {
    if (env.name === 'local') {
      if (!fs.existsSync(path.join(cfg.FINTARY_DIR, '.git'))) return { fe: 'fintary checkout not found', be: 'fintary checkout not found' }
      const dirty = git(['status', '--porcelain', '--', 'services', 'packages']) ? ' (uncommitted changes)' : ''
      const s = `${git(['rev-parse', '--abbrev-ref', 'HEAD'])} @ ${git(['rev-parse', '--short', 'HEAD'])}${dirty}`
      return { fe: s, be: s }
    }
    const [health, manifest] = await Promise.all([getJson(cfg.webUrl({ webURL: env.apiURL }, '/api/healthcheck')), getJson(cfg.webUrl(env, '/manifest.json'))])
    const built = manifest?.versionInfo?.buildTime
    return {
      fe: built ? `live web built ${built}` : 'live web build time unreadable',
      be: health?.commitSha ? `live api image from ${health.commitSha.slice(0, 10)} (${health.service ?? 'api'})` : 'live api commit unreadable',
    }
  } catch (err) {
    return { fe: `unreadable (${err.message.split('\n')[0]})`, be: 'unreadable' }
  }
}

const { tests, stats, meta } = readRun(runDir)
const st = await stamps()
const ms = n => (n >= 60_000 ? `${(n / 60_000).toFixed(1)} min` : `${(n / 1000).toFixed(1)}s`)
const icon = t => (t.status === 'passed' ? '✅' : t.status === 'skipped' ? '⏭️' : '❌')
const passed = tests.filter(t => t.status === 'passed').length
const failed = tests.filter(t => !['passed', 'skipped'].includes(t.status)).length
const skipped = tests.filter(t => t.status === 'skipped').length

const L = []
L.push(`# ${ticket} · ${env.label} · run ${runId}`, '')
L.push(`**Result:** ${failed ? `❌ ${failed} failed` : skipped ? '⚠️ incomplete' : '✅ passed'} — ${passed} passed, ${failed} failed, ${skipped} skipped · started ${stats.startTime ?? meta.startedAt ?? '?'} · ${ms(stats.duration ?? 0)}${meta.demo ? ' · narrated' : ''}`, '')
L.push('## Systems under test', '', '| System | Code — commit — target |', '|---|---|')
// Row format is read back by the MCP (video title card): | Web | `<code>` — <commit> — <target> |
L.push(`| Web | \`fintary/services/web\` — ${st.fe} — ${env.webURL} |`)
L.push(`| API | \`fintary/services/api\` — ${st.be} — ${env.apiURL} |`)
L.push('', `Account: ${meta.accountId ? `\`${meta.accountId}\`` : 'the test user\'s default'}${meta.writes ? ' · @writes cases included' : ' · @writes cases left out'}`)
L.push('', '## Cases', '', '| | Case | Project | Duration |', '|---|---|---|---:|')
for (const t of tests) L.push(`| ${icon(t)} | ${t.title.replace(/\|/g, '\\|')} | ${t.project} | ${ms(t.durationMs)} |`)

const failing = tests.filter(t => !['passed', 'skipped'].includes(t.status))
if (failing.length) {
  L.push('', '## Failures', '')
  for (const t of failing) L.push(`### ${t.title} — ${t.project}`, '', '```', t.errorFull.trim().slice(0, 1500), '```', '')
}

L.push('', '## Evidence per case', '')
for (const t of tests) {
  const figs = t.attachments.filter(a => a.contentType === 'image/png' && a.path && !a.name.endsWith(' · raw'))
  const video = t.attachments.find(a => a.name === 'video' && a.path)
  const api = t.attachments.find(a => a.name === 'api-calls')
  const consoleErr = t.attachments.find(a => a.name === 'console-errors')
  const blocked = t.annotations.filter(a => a.type === 'blocked')
  L.push(`### ${icon(t)} ${t.title} — ${t.project}`, '')
  if (t.steps.length) L.push(...t.steps.map((s, i) => `${i + 1}. ${s.error ? '❌' : '✓'} ${s.title} _(${ms(s.ms)})_`), '')
  for (const f of figs) L.push(`- ![${esc(f.name)}](${rel(runDir, f.path)})`)
  if (video) L.push(`- 🎬 [video](${rel(runDir, video.path)})`)
  if (api) {
    try {
      const log = JSON.parse(decodeAttachment(api))
      L.push('', '| # | Method | Status | ms | Path |', '|---:|---|---:|---:|---|')
      for (const c of log.calls) L.push(`| ${c.n} | ${c.method} | ${c.status ?? `error: ${c.error}`} | ${c.ms} | \`${c.path}\` |`)
      if (log.cleaned === false) L.push('', '> ⚠️ Recorded with E2E_API_FULL=1 — full bodies; do not share.')
    } catch { L.push('- api-calls: unreadable') }
  }
  if (consoleErr) L.push('', `<details><summary>Console errors</summary>\n\n\`\`\`\n${(decodeAttachment(consoleErr) ?? '').slice(0, 2000)}\n\`\`\`\n</details>`)
  for (const b of blocked) L.push(`- 🛡️ blocked: ${b.description}`)
  L.push('')
}
L.push(`_HTML report: \`npx playwright show-report ${rel(cfg.HARNESS_DIR, path.join(runDir, 'report'))}\` (from the harness folder)._`)
fs.writeFileSync(path.join(runDir, 'EVIDENCE.md'), `${L.join('\n')}\n`)

// latest -> newest run
const latest = path.join(root, 'latest')
try { fs.rmSync(latest, { force: true, recursive: false }) } catch { /* not there */ }
try { fs.symlinkSync(path.join('runs', runIds.at(-1) ?? runId), latest) } catch { /* filesystem without symlinks */ }

// RUNS.md -- the history, newest first
const R = [`# ${ticket} · ${env.label} · runs`, '', '| Run | Result | Passed | Failed | Skipped | Evidence | Video |', '|---|---|---:|---:|---:|---|---|']
for (const id of [...runIds].reverse()) {
  try {
    const r = readRun(path.join(runsDir, id))
    const p = r.tests.filter(t => t.status === 'passed').length
    const f = r.tests.filter(t => !['passed', 'skipped'].includes(t.status)).length
    const s = r.tests.filter(t => t.status === 'skipped').length
    const has = n => fs.existsSync(path.join(runsDir, id, n))
    R.push(`| ${id} | ${f ? '❌ FAIL' : s ? '⚠️ INCOMPLETE' : '✅ PASS'} | ${p} | ${f} | ${s} | ${has('EVIDENCE.md') ? `[EVIDENCE.md](runs/${id}/EVIDENCE.md)` : '—'} | ${has('report.webm') ? `[report.webm](runs/${id}/report.webm)` : '—'} |`)
  } catch { R.push(`| ${id} | unreadable | | | | | |`) }
}
fs.writeFileSync(path.join(root, 'RUNS.md'), `${R.join('\n')}\n`)
console.log(`EVIDENCE.md -> ${path.join(runDir, 'EVIDENCE.md')}`)
