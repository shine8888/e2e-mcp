#!/usr/bin/env node
// The case x screen report for one run: devices.json (for the MCP), devices.html (the demo
// report), DEVICES.md and TEAM-UPDATE.md (paste-ready text for Linear / Slack).
//
//   node scripts/build-device-report.mjs <ticket> <env> <run id>
//   env: E2E_SCOPE_NOTE        cases deliberately not run, one per line ("RE-1: reason")
//        E2E_BROWSERS_SKIPPED  browsers asked for but not installed
// Exit 2: the run has no browser tests (API-only), so there is nothing per screen.
//
// What the HTML report does for a reader:
//   - says in a sentence what was verified, on which account, against which commit
//   - surfaces run notes (a retried load, blocked writes)
//   - one row per screen: result, what was verified, layout, evidence, video
//   - every finding is ONE card (the same element on 9 screens is one finding) with an annotated
//     crop: zoomed on the element, ringed, labelled, and a "where on the page" inset
//   - evidence figures at readable size; click opens a full-size viewer (Esc closes, arrows move)
//
// Verdict rule (also in the method section):
//   any failed case, sideways overflow or cut-off content        -> "breaks found"
//   only warnings                                                -> "passed with warnings"
//   otherwise                                                    -> "no breaks found"
import fs from 'node:fs'
import path from 'node:path'
import cfg from '../lib/config.cjs'
import { readRun, decodeAttachment, columnOf, columnLabel, esc, rel } from './lib/results.mjs'
import { renderCrops } from './lib/crops.mjs'

const [ticket, envName, runId] = process.argv.slice(2)
if (!ticket || !envName || !runId) { console.error('usage: build-device-report.mjs <ticket> <env> <run id>'); process.exit(2) }
const env = cfg.envConfig(envName)
const runDir = cfg.runDir(ticket, env, runId)
const { tests: all, meta, stats } = readRun(runDir)
const tests = all.filter(t => !t.api)
if (!tests.length) { console.error(`Run ${runId} has no browser tests (API-only).`); process.exit(2) }

const splitBrowsers = new Set(tests.map(t => t.browser)).size > 1 || tests.some(t => t.project.includes('--'))
const scopeNote = process.env.E2E_SCOPE_NOTE ?? ''
const skippedBrowsers = process.env.E2E_BROWSERS_SKIPPED ?? ''
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '') + ' (Sydney)'

// ---------------------------------------------------------------------------
// Columns
const devices = []
for (const t of tests) {
  const name = columnOf(t, splitBrowsers)
  if (!devices.some(d => d.name === name)) devices.push({ name, label: columnLabel(t, splitBrowsers), short: t.deviceLabel, kind: t.kind, browser: t.browserLabel, passed: 0, failed: 0, skipped: 0, breaks: 0, clipped: 0, warns: 0 })
}
const cases = [...new Set(tests.map(t => t.title))]

const attachJson = (t, name) => { const a = t.attachments.find(x => x.name === name); if (!a) return null; try { return JSON.parse(decodeAttachment(a)) } catch { return null } }
const layoutOf = t => attachJson(t, 'layout')?.checks ?? null

// ---------------------------------------------------------------------------
// Per-case facts
const parseVerified = t => t.annotations.filter(a => a.type === 'verified').map((a) => { try { return JSON.parse(a.description) } catch { return null } }).filter(Boolean)
// What the run ran on, from the spec: test.info().annotations.push({ type: 'context', description: 'Account E2E Test account … (str_id …), user t***@example.test' })
const contextNote = tests.map(t => t.annotations.find(x => x.type === 'context')?.description).find(Boolean) ?? null
const retried = tests.map(t => ({ col: columnOf(t, splitBrowsers), label: columnLabel(t, splitBrowsers), text: t.annotations.find(a => a.type === 'retried')?.description })).filter(x => x.text)
const blocked = tests.flatMap(t => t.annotations.filter(a => a.type === 'blocked').map(a => ({ label: columnLabel(t, splitBrowsers), text: a.description })))

// Figures (the annotated ones), raw captures, video, failure screenshot -- absolute paths
const figuresOf = (t) => {
  const named = t.attachments.filter(a => a.contentType === 'image/png' && a.path && !a.name.endsWith(' · raw') && !['screenshot', 'end of test'].includes(a.name))
  if (named.length) return named.map(a => ({ name: a.name, path: a.path }))
  const eot = t.attachments.find(a => a.name === 'end of test' && a.path)
  return eot ? [{ name: 'End of test', path: eot.path }] : []
}

// ---------------------------------------------------------------------------
// Findings -> defects
const SEV_ORDER = { High: 0, Medium: 1, Low: 2 }
const normKey = s => String(s).replace(/#[\w-]*\d[\w-]*/g, '').replace(/\s+/g, ' ')
const TEXT = {
  fail: { why: 'The case failed, so this screen is not verified.', fix: 'See the error and the failure screenshot; rerun to rule out a flaky load.' },
  overflow: { why: 'The content is wider than the screen, so the page (or its content pane) has to be scrolled sideways, and controls at the edge look cut off.', fix: 'Constrain the width, let the row wrap on narrow screens, or put the wide part in its own horizontal scroller (overflow-x: auto).' },
  clipped: { why: 'The content is wider than its container, and the container hides the overflow without letting the user scroll — so the columns or controls on the right cannot be seen or reached.', fix: 'Make the container scrollable (overflow-x: auto) or let the content wrap / shrink on narrow screens.' },
  target: { why: 'WCAG 2.2 AA 2.5.8 (Target Size, Minimum): touch targets should be at least 24×24 CSS px. A small hit area is hard to tap accurately.', fix: 'Give the control a min-width / min-height of 24px (padding is enough), or space it away from its neighbours.' },
  text: { why: 'Text under 12px is hard to read on a phone.', fix: 'Raise the font size to at least 12px on phone widths.' },
}
const findings = []
for (const t of tests) {
  const col = columnOf(t, splitBrowsers)
  const dev = devices.find(d => d.name === col)
  const checks = layoutOf(t) ?? []
  const status = t.status === 'passed' ? 'passed' : t.status === 'skipped' ? 'skipped' : 'failed'
  if (status === 'passed') dev.passed++
  else if (status === 'skipped') dev.skipped++
  else dev.failed++

  const seen = new Set()
  const add = (f) => { const k = `${f.kind}|${normKey(f.key ?? f.detail)}`; if (seen.has(k)) return; seen.add(k); findings.push({ ...f, col, deviceLabel: columnLabel(t, splitBrowsers), screenKind: t.kind, case: t.title }) }
  if (status === 'failed') {
    const shot = t.attachments.find(a => a.name === 'screenshot' && a.path)?.path
    add({ kind: 'fail', severity: 'High', key: t.title, title: `Case failed: ${t.error || 'failed'}`.slice(0, 170), detail: t.errorFull, shot })
  }
  // Newest check wins for geometry; the same element across checks of one case is one finding.
  for (const c of [...checks].reverse()) {
    for (const o of c.offenders ?? []) {
      if (o.pane) {
        add({ kind: 'overflow', severity: 'Medium', key: `pane:${o.pane.selector}`, title: `Page content scrolls sideways inside its pane — ${o.pane.selector} is wider than the screen`, label: { title: `Content is ${o.pane.contentW}px wide on a ${o.pane.visibleW}px screen`, sub: `Sticks out: ${o.selector} (ends at ${o.right}px) — the page content must be scrolled sideways` }, check: c, box: o.box })
      } else {
        add({ kind: 'overflow', severity: 'Medium', key: o.selector, title: `Page scrolls sideways — ${o.selector} (${o.width}px wide, ends at ${o.right}px)`, label: { title: 'Sticks out past the screen edge', sub: `${o.selector} · ${o.width}px wide, ends at ${o.right}px` }, check: c, box: o.box })
      }
    }
    for (const x of c.clipped ?? []) add({ kind: 'clipped', severity: 'Medium', key: x.selector, title: `Content cut off — ${x.selector} hides part of its content and cannot be scrolled`, label: { title: `${x.contentW}px of content, only ${x.visibleW}px visible`, sub: x.names ? `Cut off and unreachable: ${x.names}` : 'The rest of this container is hidden and cannot be scrolled to' }, check: c, box: x.box })
    for (const s of c.smallTargets ?? []) add({ kind: 'target', severity: 'Low', key: s.selector, title: `Touch target under 24×24px — ${s.selector} (${s.width}×${s.height}px)`, label: { title: `Touch target ${s.width}×${s.height}px`, sub: 'WCAG 2.2 AA 2.5.8 minimum is 24×24px' }, check: c, box: s.box })
    if (c.smallText?.count) {
      const sm = c.smallText.samples[0]
      add({ kind: 'text', severity: 'Low', key: 'small-text', title: `Text under 12px on phones — ${[...new Set(c.smallText.samples.map(x => x.selector))].slice(0, 2).join(', ')}`, label: { title: 'Text under 12px', sub: `${c.smallText.count} element(s) on this screen` }, check: c, box: sm?.box })
    }
  }
  const mine = findings.filter(f => f.col === col && f.case === t.title)
  dev.breaks += mine.filter(f => f.kind === 'overflow' || f.kind === 'clipped').length
  dev.clipped += mine.filter(f => f.kind === 'clipped').length
  dev.warns += mine.filter(f => ['target', 'text'].includes(f.kind)).length
}

// Group: the same element on several screens is ONE defect.
const defects = []
for (const f of findings) {
  const k = `${f.kind}|${normKey(f.key ?? f.title)}`
  let d = defects.find(x => x.k === k)
  if (!d) { d = { k, kind: f.kind, severity: f.severity, title: f.title, ...TEXT[f.kind], case: f.case, screens: [], items: [] }; defects.push(d) }
  if (f.partial && d.severity === 'Low') d.severity = 'Medium'
  if (!d.screens.some(s => s.col === f.col)) d.screens.push({ col: f.col, label: f.deviceLabel, kind: f.screenKind })
  d.items.push(f)
}
defects.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.screens.length - a.screens.length)
defects.forEach((d, i) => { d.id = `D-${String(i + 1).padStart(2, '0')}` })

// Crops: the narrowest and the widest affected screen of each defect (the rest link to their full figure).
const jobs = []
for (const d of defects) {
  d.reps = []
  if (d.kind === 'fail') continue
  const withGeo = d.items.filter(i => i.box && i.check?.shot)
  const byW = [...withGeo].sort((a, b) => a.check.viewport - b.check.viewport)
  const picks = [...new Set([byW[0], byW.at(-1)].filter(Boolean))]
  for (const it of picks) {
    const file = `${d.id}_${it.col.replace(/[^a-z0-9]+/gi, '-')}.png`
    jobs.push({ file, raw: it.check.shot, dpr: it.check.dpr, box: it.box, tone: d.severity === 'Low' ? 'warn' : 'bad', label: it.label, screen: it.deviceLabel, id: d.id, severity: d.severity })
    d.reps.push({ col: it.col, label: it.deviceLabel, file })
  }
}
const cropsDir = path.join(runDir, 'findings')
fs.rmSync(cropsDir, { recursive: true, force: true })
const rendered = await renderCrops(jobs, cropsDir)
const renderedFiles = new Set(rendered.map(r => r.file))
for (const d of defects) d.reps = d.reps.filter(r => renderedFiles.has(r.file)).map(r => ({ ...r, rel: `findings/${r.file}` }))
for (const d of defects) d.shot = d.reps[0]?.rel ?? (d.kind === 'fail' && d.items[0]?.shot ? rel(runDir, d.items[0].shot) : null)

// ---------------------------------------------------------------------------
// Matrix, totals, verdict
const layoutString = (col, caseTitle) => {
  const mine = findings.filter(f => f.col === col && f.case === caseTitle)
  const brk = mine.filter(f => f.kind === 'overflow')
  const cut = mine.filter(f => f.kind === 'clipped')
  if (brk.length) return '✗ sideways overflow'
  if (cut.length) return '✗ content cut off'
  const tg = mine.filter(f => f.kind === 'target').length
  const tx = mine.some(f => f.kind === 'text')
  const bits = [tg ? `${tg} small touch target${tg > 1 ? 's' : ''}` : '', tx ? 'small text' : ''].filter(Boolean)
  return bits.length ? `⚠ ${bits.join(', ')}` : (layoutOf(tests.find(t => columnOf(t, splitBrowsers) === col && t.title === caseTitle) ?? {}) === null ? 'not audited' : 'layout ok')
}
const matrix = cases.map(c => ({ case: c, results: {} }))
for (const t of tests) {
  const col = columnOf(t, splitBrowsers)
  const status = t.status === 'passed' ? 'passed' : t.status === 'skipped' ? 'skipped' : 'failed'
  matrix.find(r => r.case === t.title).results[col] = { status, layout: layoutString(col, t.title), project: t.project, durationMs: t.durationMs }
}
const totals = {
  cases: cases.length,
  runs: tests.length,
  failed: tests.filter(t => !['passed', 'skipped'].includes(t.status)).length,
  skipped: tests.filter(t => t.status === 'skipped').length,
  breaks: devices.reduce((n, d) => n + d.breaks, 0),
  warnings: devices.reduce((n, d) => n + d.warns, 0),
}
const verdict = totals.failed || totals.breaks ? 'breaks found' : totals.warnings ? 'passed with warnings' : 'no breaks found'
const count = s => defects.filter(d => d.severity === s).length
const assessment = defects.length ? `${count('High')} high, ${count('Medium')} medium, ${count('Low')} low` : 'no defects'
const issues = defects.filter(d => d.severity !== 'Low').flatMap(d => d.screens.map(s => ({ severity: d.kind === 'fail' ? 'fail' : 'break', device: s.col, deviceLabel: s.label, case: d.case, detail: d.title, elements: [d.title], shot: d.shot ? path.join(runDir, d.shot) : null })))
// Per-screen records the MCP reads
const findingsFlat = findings.map(f => ({ severity: f.kind === 'fail' ? 'fail' : f.kind === 'overflow' || f.kind === 'clipped' ? 'break' : 'warn', device: f.col, deviceLabel: f.deviceLabel, case: f.case, kind: f.kind, detail: f.title, elements: [f.title.split(' — ').slice(1).join(' — ') || f.title], shot: f.shot }))

// Evidence per screen
const screens = devices.map((d) => {
  const t = tests.find(x => columnOf(x, splitBrowsers) === d.name)
  const ver = parseVerified(t)
  const video = t.attachments.find(a => a.name === 'video' && a.path)?.path
  return {
    ...d, status: t.status === 'passed' ? 'passed' : t.status === 'skipped' ? 'skipped' : 'failed', verified: ver, error: t.error, errorFull: t.errorFull, retried: t.annotations.find(a => a.type === 'retried')?.description ?? null,
    figures: figuresOf(t).map(f => ({ name: f.name, rel: rel(runDir, f.path) })), video: video ? rel(runDir, video) : null, layout: layoutString(d.name, t.title),
  }
})
const steps = []
for (const s of screens) for (const f of s.figures) { let g = steps.find(x => x.name === f.name); if (!g) { g = { case: cases[0], name: f.name, shots: [] }; steps.push(g) } g.shots.push({ screen: s.label, path: f.rel, status: s.status }) }
const reel = fs.existsSync(path.join(runDir, 'report.webm')) ? 'report.webm' : null

// Tested-against line from this run's EVIDENCE.md
const evMd = fs.existsSync(path.join(runDir, 'EVIDENCE.md')) ? fs.readFileSync(path.join(runDir, 'EVIDENCE.md'), 'utf-8') : ''
const sys = evMd.match(/\| Web \| `[^`]+` — (.+?) — (\S+) \|/)
const testedAgainst = sys ? sys[1] : null

const files = { md: path.join(runDir, 'DEVICES.md'), html: path.join(runDir, 'devices.html'), json: path.join(runDir, 'devices.json'), teamUpdate: path.join(runDir, 'TEAM-UPDATE.md') }
const anyEmulated = devices.some(d => /iPhone|iPad/.test(d.label)) && !tests.some(t => t.browser === 'safari')
const method = [
  'Each case ran once per column in its own browser session built from a Playwright 1.60 device profile (viewport, pixel ratio, touch, isMobile, user agent).',
  anyEmulated ? 'iPhone / iPad columns are Apple viewports and user agents in Chromium, not Safari — a WebKit-only bug needs browsers: safari.' : null,
  tests.some(t => t.browser === 'safari') ? 'Safari columns run in Playwright\'s WebKit build: Safari\'s engine, not Safari.app.' : null,
  'Evidence figures are full-page captures taken with the demo narration hidden. Green ring = checked and correct, red = wrong, amber = warning, blue = marked. Finding crops zoom on the element, ring it and show where it sits on the page.',
  'Layout audit at every evidence snap and at the end of every case. Break = the page, or its full-width content pane, scrolls sideways. Cut off = content is wider than a container that hides overflow and cannot be scrolled (a wide table in a card with overflow:hidden), so it cannot be seen or reached. Warning = touch targets under 24×24px on touch screens (WCAG 2.2 AA 2.5.8), text under 12px on phones. Only selectors, sizes, positions and the labels of cut-off headings / buttons are recorded, never page or customer data. Content inside its own horizontal scroller does not count.',
  'Verdict: any failed case, sideways overflow or cut-off content = defects found; warnings only = passed with minor items; otherwise passed. Skipped cases are unproven, never passed.',
  'The same element on several screens is reported once, with the narrowest and widest affected screen shown; the others are listed.',
  'Results reflect this run only.',
].filter(Boolean)

const report = {
  ticket, env: env.name, envLabel: env.label, run: runId, startedAt: stats.startTime ?? meta.startedAt ?? null,
  verdict, assessment, totals, devices, matrix, findings: findingsFlat, issues, defects: defects.map(({ items, k, reps, ...d }) => ({ ...d, screens: d.screens.map(s => s.label), reps })), steps, method, context: contextNote, testedAgainst,
  notes: { retried, blocked }, scopeNote: scopeNote || null, skippedBrowsers: skippedBrowsers || null,
  videos: screens.filter(s => s.video).map(s => ({ case: cases[0], screen: s.label, path: s.video })), reel, files,
}
fs.writeFileSync(files.json, JSON.stringify(report, null, 2))

// ---------------------------------------------------------------------------
// Words
const verifiedAll = screens.flatMap(s => s.verified)
const verifiedCount = verifiedAll.reduce((n, v) => n + v.count, 0)
const verifiedWrong = verifiedAll.reduce((n, v) => n + v.wrong, 0)
// A spec reports what it checked with test.info().annotations.push({ type: 'verified',
// description: JSON.stringify({ tab: '<where>', what: '<what was checked>', count, wrong, expected: '<the expected value>' }) }).
const labelOf = v => v.tab ?? v.where ?? v.what ?? 'checks'
const verifiedSentence = verifiedAll.length
  ? `${contextNote ? `On ${contextNote}: ` : ''}${verifiedCount - verifiedWrong} of ${verifiedCount} ${[...new Set(verifiedAll.map(v => v.what).filter(Boolean))].join(' / ') || 'checked values'} were as expected (${[...new Set(verifiedAll.map(v => v.expected).filter(Boolean))].join(' / ') || 'per the spec'}) across ${screens.length} screen${screens.length > 1 ? 's' : ''}, on ${[...new Set(verifiedAll.map(labelOf))].join(' and ')}.${verifiedWrong ? ` ${verifiedWrong} were not — see the red rings.` : ''}`
  : null
const verdictLabel = { 'breaks found': 'Defects found', 'passed with warnings': 'Passed with minor items', 'no breaks found': 'Passed' }[verdict]
const verdictIcon = { 'breaks found': '✕', 'passed with warnings': '!', 'no breaks found': '✓' }[verdict]
const tone = verdict === 'no breaks found' ? 'good' : verdict === 'breaks found' ? 'bad' : 'warn'

// ---------------------------------------------------------------------------
// DEVICES.md
const verdictMd = { 'breaks found': '❌ Defects found', 'passed with warnings': '⚠️ Passed with minor items', 'no breaks found': '✅ Passed' }[verdict]
const M = []
M.push(`# ${ticket} · ${env.label} · ${devices.length > 1 ? 'multi-device' : 'single-screen'} test report`, '', `**${verdictMd}** — run ${runId} · ${totals.cases} case(s) × ${devices.length} column(s) · ${totals.failed} failed · ${totals.breaks} break(s) · ${totals.warnings} warning(s) · ${assessment}`, '')
if (verifiedSentence) M.push(`**Verified:** ${verifiedSentence}`, '')
for (const r of retried) M.push(`> Note: ${r.label} — ${r.text.replace(/\.+$/, '')}.`, '')
if (scopeNote) M.push(`**Not run:** ${scopeNote.split('\n').filter(Boolean).join('; ')}`, '')
if (skippedBrowsers) M.push(`**Browsers skipped (not installed):** ${skippedBrowsers}`, '')
M.push('## Results', '', '| Screen | Result | Verified | Layout |', '|---|---|---|---|')
for (const s of screens) M.push(`| ${s.label} | ${s.status === 'passed' ? '✅ Pass' : s.status === 'skipped' ? '⏭️ Skipped' : '❌ Fail'} | ${s.verified.map(v => `${labelOf(v)}: ${v.count - v.wrong}/${v.count}${v.expected ? ` ${v.expected}` : ''}`).join(' · ') || '—'} | ${s.layout} |`)
M.push('', '## Findings', '')
if (!defects.length) M.push('None.')
for (const d of defects) {
  M.push(`### ${d.id} · ${d.severity} · ${d.title}`, '', `${d.why}`, '', `Fix: ${d.fix}`, '', `Screens (${d.screens.length}): ${d.screens.map(s => s.label).join(', ')}`, '')
  for (const r of d.reps) M.push(`![${d.id} — ${r.label}](${r.rel})`, '')
}
M.push('## Evidence by screen', '')
for (const s of screens) { M.push(`### ${s.label} — ${s.status}`, ''); for (const f of s.figures) M.push(`![${f.name}](${f.rel})`, ''); if (s.video) M.push(`[video](${s.video})`, '') }
if (reel) M.push('Narrated reel: [report.webm](report.webm)', '')
M.push('## Method', '', ...method.map(m => `- ${m}`))
fs.writeFileSync(files.md, `${M.join('\n')}\n`)

// ---------------------------------------------------------------------------
// devices.html
const sevPill = s => `<span class="pill sev-${s}">${s}</span>`
const resultPill = s => `<span class="pill ${s === 'passed' ? 'good' : s === 'skipped' ? 'dim' : 'bad'}">${s === 'passed' ? 'Pass' : s === 'skipped' ? 'Skipped' : 'Fail'}</span>`
const layoutPill = l => `<span class="pill ${l.startsWith('✗') ? 'bad' : l.startsWith('⚠') ? 'warn' : 'good'}">${esc(l.replace(/^[✗⚠] /, ''))}</span>`
const kindChip = k => `<span class="chip">${k === 'phone' ? 'Phone' : k === 'tablet' ? 'Tablet' : 'Desktop'}</span>`
const lb = (src, cap, inner) => `<a class="lb" href="${esc(src)}" data-cap="${esc(cap)}" target="_blank" rel="noopener">${inner}</a>`
const verifiedCell = s => (s.verified.length ? s.verified.map(v => `<div class="ver ${v.wrong ? 'bad' : 'good'}"><b>${esc(labelOf(v))}</b> ${v.count - v.wrong}/${v.count}${v.expected ? ` ${esc(v.expected)}` : ''}</div>`).join('') : (s.status === 'failed' ? '<span class="dim">not verified</span>' : '<span class="dim">—</span>'))

const notes = []
for (const r of retried) notes.push({ tone: 'warn', title: `Load retried — ${r.label}`, text: `${r.text.replace(/\.+$/, '')}. The page failed to load once (a transport error, not an application result), was reloaded once, and then passed. Recorded here so it is never silent.` })
if (blocked.length) notes.push({ tone: 'info', title: 'Writes blocked', text: `${blocked.length} write call(s) to the preview / production API were blocked by the guard: ${[...new Set(blocked.map(b => b.text))].slice(0, 3).join('; ')}` })
if (scopeNote) notes.push({ tone: 'info', title: 'Not run in this report', text: scopeNote.split('\n').filter(Boolean).join('; ') })
if (skippedBrowsers) notes.push({ tone: 'warn', title: 'Browsers skipped (not installed)', text: skippedBrowsers })

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ticket)} test report</title><style>
:root{--bg:#fff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--card:#f8fafc;--good:#15803d;--bad:#b91c1c;--warn:#b45309;--accent:#2563eb;--goodbg:#dcfce7;--badbg:#fee2e2;--warnbg:#fef3c7;--infobg:#dbeafe}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--card:#111a2e;--good:#4ade80;--bad:#f87171;--warn:#fbbf24;--accent:#60a5fa;--goodbg:#14532d66;--badbg:#7f1d1d66;--warnbg:#78350f66;--infobg:#1e3a8a66}}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:64px}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1240px;margin:0 auto;padding:0 20px 80px}
nav{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 20px}
nav div{max-width:1240px;margin:0 auto;display:flex;gap:6px;flex-wrap:wrap;align-items:center}nav b{margin-right:10px}
nav a{color:var(--fg);text-decoration:none;padding:4px 12px;border-radius:999px;font-size:14px}nav a:hover{background:var(--card)}
h1{font-size:28px;line-height:1.2;margin:28px 0 6px}h2{font-size:21px;margin:44px 0 14px}h3{margin:0}
.sub{color:var(--muted)}.dim{color:var(--muted)}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.chip{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:1px 10px;font-size:12.5px;color:var(--muted);white-space:nowrap}
.verdict{display:inline-flex;align-items:center;gap:10px;margin:14px 0 4px;padding:8px 18px 8px 10px;border-radius:999px;font-weight:700;font-size:17px}
.verdict i{font-style:normal;display:inline-flex;width:28px;height:28px;border-radius:50%;align-items:center;justify-content:center;color:#fff;font-size:16px}
.verdict.good{background:var(--goodbg);color:var(--good)}.verdict.good i{background:var(--good)}.verdict.bad{background:var(--badbg);color:var(--bad)}.verdict.bad i{background:var(--bad)}.verdict.warn{background:var(--warnbg);color:var(--warn)}.verdict.warn i{background:var(--warn)}
.lead{font-size:17px;margin:12px 0;max-width:900px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.kpi b{display:block;font-size:28px;line-height:1.1}.kpi span{color:var(--muted);font-size:13px}
.note{border-radius:10px;padding:12px 16px;margin:10px 0;border-left:5px solid}.note b{display:block}.note.warn{background:var(--warnbg);border-color:var(--warn)}.note.info{background:var(--infobg);border-color:var(--accent)}
.pill{display:inline-block;padding:1px 10px;border-radius:999px;font-size:12.5px;font-weight:650;white-space:nowrap}
.pill.good{background:var(--goodbg);color:var(--good)}.pill.bad,.pill.sev-High{background:var(--badbg);color:var(--bad)}.pill.warn,.pill.sev-Medium{background:var(--warnbg);color:var(--warn)}.pill.dim{background:var(--card);color:var(--muted)}.pill.sev-Low{background:var(--infobg);color:var(--accent)}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%}
th,td{padding:10px 14px;text-align:left;vertical-align:middle;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:var(--card);white-space:nowrap}
.ver{font-size:13.5px;white-space:nowrap}.ver.good b{color:var(--good)}.ver.bad b{color:var(--bad)}
.thumbs{display:flex;gap:6px}.thumbs a{display:block;width:58px;height:74px;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:#fff}.thumbs img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}
.defect{border:1px solid var(--line);border-radius:14px;margin:18px 0;overflow:hidden;background:var(--bg)}
.defect>header{padding:16px 20px;background:var(--card);border-bottom:1px solid var(--line)}.defect>header h3{font-size:17px;margin:6px 0 0;line-height:1.35;word-break:break-word}
.defect .body{padding:16px 20px}.defect .why{margin:0 0 6px}.defect .fix{margin:0 0 12px;color:var(--muted)}
.screens{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 14px}
.crops{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px}.crops figure{margin:0}.crops img{width:100%;border:1px solid var(--line);border-radius:10px;display:block;background:#fff}
figcaption{font-size:13px;color:var(--muted);margin-top:6px}
details.scr{border:1px solid var(--line);border-radius:14px;margin:16px 0;background:var(--bg)}details.scr>summary{cursor:pointer;list-style:none;padding:14px 20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-weight:650}
details.scr>summary::-webkit-details-marker{display:none}details.scr>summary:before{content:"▸";color:var(--muted)}details.scr[open]>summary:before{content:"▾"}
details.scr .inner{padding:4px 20px 20px}.figs{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));align-items:start}.figs.desk{grid-template-columns:1fr}
.figs figure{margin:0}.figs img{width:100%;display:block;border:1px solid var(--line);border-radius:10px;background:#fff}
.figs figcaption b{color:var(--fg)}.err{white-space:pre-wrap;background:var(--badbg);border-radius:8px;padding:10px 14px;font:12.5px/1.5 ui-monospace,Menlo,monospace}
.lb{cursor:zoom-in}ul.method li{margin:5px 0}
#lbx{position:fixed;inset:0;background:#020617f2;z-index:100;display:none;flex-direction:column}#lbx.on{display:flex}
#lbx .bar{display:flex;gap:12px;align-items:center;padding:10px 16px;color:#e2e8f0;font-size:14px}#lbx .bar span{flex:1}
#lbx button,#lbx a.open{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer;text-decoration:none}
#lbx .stage{flex:1;overflow:auto;text-align:center;padding:0 16px 24px}#lbx img{max-width:100%;border-radius:8px;background:#fff;cursor:zoom-in}#lbx img.full{max-width:none;cursor:zoom-out}
@media print{nav,#lbx{display:none}body{font-size:12px}details.scr{break-inside:auto}.defect,figure,.kpi{break-inside:avoid}h2{break-after:avoid}.crops{grid-template-columns:1fr 1fr}.figs{grid-template-columns:1fr 1fr 1fr}.figs.desk{grid-template-columns:1fr}}
</style></head><body>
<nav><div><b>${esc(ticket)}</b><a href="#summary">Summary</a>${notes.length ? '<a href="#notes">Notes</a>' : ''}<a href="#screens">Screens</a><a href="#findings">Findings (${defects.length})</a><a href="#evidence">Evidence</a>${reel ? '<a href="report.webm">Video reel</a>' : ''}<a href="#method">Method</a></div></nav>
<main>
<h1>${esc(ticket)} · ${devices.length > 1 ? 'Multi-device' : 'Automated'} test report</h1>
<div class="chips"><span class="chip">${esc(env.label)}</span>${contextNote ? `<span class="chip">${esc(contextNote)}</span>` : ''}<span class="chip">Run ${esc(runId)}</span><span class="chip">${esc(when(report.startedAt))}</span><span class="chip">${devices.length} screen${devices.length > 1 ? 's' : ''}</span>${[...new Set(tests.map(t => t.browserLabel))].map(b => `<span class="chip">${esc(b)}</span>`).join('')}${testedAgainst ? `<span class="chip">${esc(testedAgainst)}</span>` : ''}</div>
<div class="verdict ${tone}" id="summary"><i>${verdictIcon}</i>${esc(verdictLabel)} · ${esc(assessment)}</div>
${verifiedSentence ? `<p class="lead">${esc(verifiedSentence)}</p>` : ''}
<div class="kpis">
<div class="kpi"><b>${totals.runs - totals.failed - totals.skipped}/${totals.runs}</b><span>screens passed</span></div>
${verifiedAll.length ? `<div class="kpi"><b>${verifiedCount - verifiedWrong}/${verifiedCount}</b><span>checked values as expected</span></div>` : ''}
<div class="kpi"><b>${totals.failed}</b><span>failed</span></div>
<div class="kpi"><b>${devices.filter(d => d.breaks > 0).length}/${devices.length}</b><span>screens with a layout break (sideways scroll or cut-off content)</span></div>
<div class="kpi"><b>${defects.filter(d => d.severity === 'Low').length}</b><span>minor findings (warnings)</span></div></div>
${notes.length ? `<h2 id="notes">Notes on this run</h2>${notes.map(n => `<div class="note ${n.tone}"><b>${esc(n.title)}</b>${esc(n.text)}</div>`).join('')}` : ''}

<h2 id="screens">Results by screen</h2>
<div class="wrap"><table><thead><tr><th>Screen</th><th>Result</th><th>Verified</th><th>Layout</th><th>Evidence</th><th>Video</th></tr></thead><tbody>
${screens.map(s => `<tr><td><b>${esc(s.short)}</b><br>${kindChip(s.kind)} <span class="chip">${esc(s.browser)}</span></td><td>${resultPill(s.status)}</td><td>${verifiedCell(s)}</td><td>${layoutPill(s.layout)}</td>
<td><div class="thumbs">${s.figures.slice(0, 3).map(f => lb(f.rel, `${s.label} — ${f.name}`, `<img loading="lazy" src="${esc(f.rel)}" alt="">`)).join('')}</div></td>
<td>${s.video ? `<a href="${esc(s.video)}">video</a>` : '—'}</td></tr>`).join('')}
</tbody></table></div>

<h2 id="findings">Findings</h2>
${defects.length ? `<p class="sub">Each card is one problem. The same element on several screens is shown once — on the narrowest and the widest affected screen — and every affected screen is listed. The ring marks the element, the label says what is wrong, and the inset shows where it sits on the page. Click an image to view it full size.</p>` : '<p>No defects found.</p>'}
${defects.map(d => `<article class="defect" id="${d.id}"><header>${sevPill(d.severity)} <span class="chip">${d.id}</span> <span class="chip">${d.screens.length} screen${d.screens.length > 1 ? 's' : ''}</span><h3>${esc(d.title)}</h3></header><div class="body">
<p class="why"><b>Why it matters.</b> ${esc(d.why)}</p><p class="fix"><b>Suggested fix.</b> ${esc(d.fix)}</p>
<div class="screens">${d.screens.map(s => `<span class="chip">${esc(s.label)}</span>`).join('')}</div>
${d.kind === 'fail' ? `<pre class="err">${esc(d.items[0].detail ?? '')}</pre>${d.shot ? lb(d.shot, `${d.id} — failure screenshot`, `<img src="${esc(d.shot)}" alt="" style="max-width:420px;width:100%;border:1px solid var(--line);border-radius:10px">`) : ''}`
  : `<div class="crops">${d.reps.map(r => `<figure>${lb(r.rel, `${d.id} — ${r.label}`, `<img loading="lazy" src="${esc(r.rel)}" alt="${esc(d.title)}">`)}<figcaption><b>${esc(r.label)}</b> — click to enlarge</figcaption></figure>`).join('') || '<p class="dim">No annotated crop (the raw capture was not available).</p>'}</div>`}
</div></article>`).join('')}

<h2 id="evidence">Evidence by screen</h2>
<p class="sub">Full-page captures: green ring = checked and as expected, red = not, amber = layout warning. Click any image for the full-size viewer (←/→ to move, Esc to close, click the image for actual size).</p>
${screens.map(s => `<details class="scr" ${s.kind === 'desktop' || s.status === 'failed' ? 'open' : ''}><summary>${esc(s.label)} ${resultPill(s.status)} ${layoutPill(s.layout)} ${s.video ? `<a href="${esc(s.video)}" style="font-weight:500;margin-left:auto">▶ video</a>` : ''}</summary><div class="inner">
${s.retried ? `<div class="note warn"><b>Load retried</b>${esc(s.retried)}</div>` : ''}${s.error && s.status === 'failed' ? `<pre class="err">${esc(s.errorFull || s.error)}</pre>` : ''}
<div class="figs ${s.kind === 'desktop' ? 'desk' : ''}">${s.figures.map(f => `<figure>${lb(f.rel, `${s.label} — ${f.name}`, `<img loading="lazy" src="${esc(f.rel)}" alt="${esc(f.name)}">`)}<figcaption><b>${esc(f.name)}</b> · <a href="${esc(f.rel)}" target="_blank" rel="noopener">open full size</a></figcaption></figure>`).join('') || '<p class="dim">No figures were captured for this screen.</p>'}</div></div></details>`).join('')}
${reel ? `<h2>Video reel</h2><p><a href="report.webm">report.webm</a> — every screen in one narrated recording, one chapter per screen.</p>` : ''}
<h2 id="method">Method and definitions</h2><ul class="method">${method.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
</main>
<div id="lbx" role="dialog" aria-modal="true"><div class="bar"><span id="lbc"></span><a class="open" id="lbo" target="_blank" rel="noopener">Open in new tab</a><button id="lbp">‹ Prev</button><button id="lbn">Next ›</button><button id="lbz">Actual size</button><button id="lbx-close">Close (Esc)</button></div><div class="stage"><img id="lbi" alt=""></div></div>
<script>
(function(){var links=[].slice.call(document.querySelectorAll('a.lb')),box=document.getElementById('lbx'),img=document.getElementById('lbi'),cap=document.getElementById('lbc'),open=document.getElementById('lbo'),cur=-1;
function show(i){cur=(i+links.length)%links.length;var a=links[cur];img.className='';img.src=a.getAttribute('href');cap.textContent=a.getAttribute('data-cap')||'';open.href=a.getAttribute('href');box.className='on';document.body.style.overflow='hidden'}
function hide(){box.className='';document.body.style.overflow='';cur=-1}
links.forEach(function(a,i){a.addEventListener('click',function(e){if(e.metaKey||e.ctrlKey)return;e.preventDefault();show(i)})});
img.addEventListener('click',function(){img.className=img.className?'':'full'});
document.getElementById('lbz').onclick=function(){img.className=img.className?'':'full'};document.getElementById('lbx-close').onclick=hide;
document.getElementById('lbp').onclick=function(){show(cur-1)};document.getElementById('lbn').onclick=function(){show(cur+1)};
document.addEventListener('keydown',function(e){if(cur<0)return;if(e.key==='Escape')hide();else if(e.key==='ArrowLeft')show(cur-1);else if(e.key==='ArrowRight')show(cur+1)});
box.addEventListener('click',function(e){if(e.target===box||e.target.className==='stage')hide()})})();
</script></body></html>`
fs.writeFileSync(files.html, html)

// ---------------------------------------------------------------------------
// TEAM-UPDATE.md (text only: paste-ready for Slack or a Linear comment)
const T = []
T.push(`*${ticket} — automated ${devices.length > 1 ? 'multi-device test' : 'test'} on ${env.label}: ${verdictLabel}*`)
T.push(`Run ${runId}: ${totals.cases} case(s) on ${devices.length} screen(s). ${totals.runs - totals.failed - totals.skipped} of ${totals.runs} passed${totals.failed ? `, ${totals.failed} failed` : ''}${totals.skipped ? `, ${totals.skipped} skipped` : ''}.`)
if (verifiedSentence) T.push('', `Verified: ${verifiedSentence}`)
for (const r of retried) T.push('', `Note: ${r.label} — ${r.text.replace(/\.+$/, '')} (reloaded once, then passed).`)
if (defects.length) { T.push('', 'Issues:'); for (const d of defects) T.push(`- ${d.id} (${d.severity}) ${d.title} — ${d.screens.length === devices.length ? 'all screens' : `${d.screens.length} screen(s): ${d.screens.map(s => s.label).join(', ')}`}`) } else T.push('', 'No defects found.')
if (scopeNote) T.push('', `Not run: ${scopeNote.split('\n').filter(Boolean).join('; ')}`)
T.push('', `Full report with screenshots: devices.html in the run folder (${rel(cfg.HARNESS_DIR, runDir)}) — attach it or the PDF by hand; this text has no attachments.`)
fs.writeFileSync(files.teamUpdate, `${T.join('\n')}\n`)

console.log(JSON.stringify({ verdict, totals, defects: defects.length, crops: rendered.length, files }, null, 2))
