// Where a ticket's evidence lives, run by run. The harness writes every run to
// tickets/<T>/<evidence dir>/runs/<YYYY-MM-DD_HH-MM-SS>/ and points `latest`
// at the newest (playwright.config.ts + build-report.mjs), so a new run can
// never erase an older one. A flat run at the evidence root (results.json next
// to runs/, e.g. copied in by hand) is read as a single run named "legacy".
//
// Every reader in this server resolves paths through here -- nothing else
// joins an evidence path by hand.
import fs from 'node:fs'
import path from 'node:path'
import { FT_E2E_DIR } from '../ft-e2e.mjs'

export function evidenceRootFor (env, ticket) {
  if (!env?.evidenceDir) return null
  return path.join(FT_E2E_DIR, 'tickets', ticket, env.evidenceDir)
}

/** Same format as harness/lib/config.cjs newRunId(), so one scheme names every run. */
export function newRunId (d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

/** Recorded runs, oldest first. Only runs that produced a results.json count. */
export function listRuns (env, ticket) {
  const root = evidenceRootFor(env, ticket)
  if (!root) return []
  const runs = []
  if (fs.existsSync(path.join(root, 'results.json'))) runs.push({ id: 'legacy', dir: root })
  const runsDir = path.join(root, 'runs')
  if (fs.existsSync(runsDir)) {
    for (const id of fs.readdirSync(runsDir).sort()) {
      const dir = path.join(runsDir, id)
      if (fs.existsSync(path.join(dir, 'results.json'))) runs.push({ id, dir })
    }
  }
  return runs
}

/**
 * The folder of one run: `run` names it (an id from listRuns, or "legacy"),
 * or omitted / "latest" for the newest. Returns null when there is none.
 */
export function resolveRunDir (env, ticket, run = 'latest') {
  const runs = listRuns(env, ticket)
  if (!runs.length) return null
  if (run && run !== 'latest') return runs.find(r => r.id === run)?.dir ?? null
  return runs.at(-1).dir
}
