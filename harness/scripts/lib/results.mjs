// Reads one run's Playwright results.json into flat rows -- shared by
// build-report.mjs and build-device-report.mjs so both see the same tests.
import fs from 'node:fs'
import path from 'node:path'

const ANSI = /\u001b\[[0-9;]*m/g
export const stripAnsi = s => String(s ?? '').replace(ANSI, '')

export function decodeAttachment (a) {
  try {
    if (a.path && fs.existsSync(a.path)) return fs.readFileSync(a.path, 'utf-8')
    if (a.body) return Buffer.from(a.body, 'base64').toString('utf-8')
  } catch { /* unreadable */ }
  return null
}

export function readRun (runDir) {
  const resultsFile = path.join(runDir, 'results.json')
  if (!fs.existsSync(resultsFile)) throw new Error(`No results.json in ${runDir}`)
  const data = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'))
  const metaFile = path.join(runDir, 'run-meta.json')
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf-8')) : {}
  const projectMeta = Object.fromEntries((data.config?.projects ?? []).map(p => [p.name, p.metadata ?? {}]))
  const tests = []
  const walk = (suite, file) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.at(-1) ?? {}
        const pm = projectMeta[t.projectName] ?? {}
        const error = stripAnsi(last.error?.message ?? last.errors?.[0]?.message ?? '')
        tests.push({
          title: spec.title,
          file: spec.file ?? file,
          line: spec.line,
          project: t.projectName,
          api: !!pm.api || t.projectName === 'api',
          device: pm.device ?? (t.projectName?.startsWith('device-') ? t.projectName.slice(7).split('--')[0] : 'desktop'),
          deviceLabel: pm.deviceLabel ?? t.projectName,
          kind: pm.kind ?? 'desktop',
          browser: pm.browser ?? 'chromium',
          browserLabel: pm.browserLabel ?? 'Chromium',
          mobileEmulation: pm.mobileEmulation !== false,
          outcome: t.status, // expected | unexpected | flaky | skipped
          status: last.status ?? 'skipped', // passed | failed | timedOut | skipped | interrupted
          durationMs: last.duration ?? 0,
          error: error.split('\n').find(l => l.trim()) ?? '',
          errorFull: error.slice(0, 3000),
          attachments: last.attachments ?? [],
          annotations: t.annotations ?? [],
          steps: (last.steps ?? []).map(s => ({ title: s.title, ms: s.duration, error: !!s.error })),
        })
      }
    }
    for (const child of suite.suites ?? []) walk(child, child.file ?? file)
  }
  for (const s of data.suites ?? []) walk(s, s.file)
  return { data, meta, tests, stats: data.stats ?? {} }
}

/** The column a test belongs to: its screen, plus its browser when the run split by browser. */
export function columnOf (t, splitBrowsers) {
  return splitBrowsers ? `${t.device}--${t.browser}` : t.device
}
export function columnLabel (t, splitBrowsers) {
  const base = t.deviceLabel
  if (!splitBrowsers) return base
  return `${base} · ${t.browserLabel}${t.mobileEmulation ? '' : ' (no mobile emulation)'}`
}

export const rel = (from, p) => path.relative(from, p).split(path.sep).join('/')
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
