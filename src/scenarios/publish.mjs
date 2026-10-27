// Publish a run to its Linear issue: the report as a PDF, the annotated
// evidence images, the narrated video as MP4, and one comment that shows the
// images inline and links the rest.
//
// Two steps, on purpose:
//   preparePublish   builds everything LOCALLY in <run>/publish/ and returns a
//                    preview (comment text, files, sizes) plus a digest. Writes
//                    nothing to Linear.
//   publishToLinear  uploads exactly the prepared payload -- refused unless the
//                    caller passes the digest it was shown, so what was reviewed
//                    is what is posted -- and records it in published.json so a
//                    run is never posted twice by accident.
//
// Linear GraphQL (https://api.linear.app/graphql), the same flow the fintary repo
// practises in SKILLS/run-app/references/evidence-linear.md: fileUpload -> PUT the
// bytes to the signed URL with every returned header -> attachmentCreate on the
// issue -> one commentCreate embedding each assetUrl. Only comments and
// attachments; never a label, a status or another issue.
//
// Credentials: a Linear personal API key in the macOS Keychain, service
// "ft-e2e-linear"
//   security add-generic-password -s ft-e2e-linear -a <your email> -w
// LINEAR_API_KEY overrides it. The key and the signed upload URLs are never
// logged or returned.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { childPath, runInHarness } from '../ft-e2e.mjs'
import { DEFAULT_ENV, knownEnv } from '../env.mjs'
import { resolveRunDir } from './runs.mjs'
import { buildDeviceReport } from './devices.mjs'
import { checkToolkit } from './toolkit.mjs'

export const LINEAR_API = process.env.LINEAR_API_URL || 'https://api.linear.app/graphql'
const KEYCHAIN_SERVICE = 'ft-e2e-linear'
const MAX_VIDEO_MB = 90

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex')
const mb = bytes => Number((bytes / 1_048_576).toFixed(1))
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)
// Markdown control characters in free text (titles come from specs).
const md = s => String(s).replace(/([\\`*_[\]<>|])/g, '\\$1')
// A fresh RegExp per use: a shared /g regex keeps lastIndex between .test calls.
const EMAIL = () => /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const CONTENT_TYPE = { '.png': 'image/png', '.pdf': 'application/pdf', '.mp4': 'video/mp4' }

function apiKey () {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY
  try {
    return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null
  } catch { return null }
}

export function credentialStatus () {
  return apiKey()
    ? { ok: true, api: LINEAR_API, source: process.env.LINEAR_API_KEY ? 'LINEAR_API_KEY' : `Keychain ${KEYCHAIN_SERVICE}` }
    : { ok: false, api: LINEAR_API, fix: `security add-generic-password -s ${KEYCHAIN_SERVICE} -a <your email> -w   (create a personal API key in Linear: Settings > Account > Security & access)` }
}

function ffmpeg (args, timeoutMs = 15 * 60_000) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args, { env: { ...process.env, PATH: childPath() } })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stderr: err.message }) })
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-3000) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }) })
  })
}

/** Figures worth showing on the ticket: defect evidence first, else the last figure of each case. */
function pickImages (dir, devicesJson, max) {
  const labelOf = name => devicesJson.devices.find(d => d.name === name)?.label ?? name
  const out = []
  const add = (rel, why) => {
    if (!rel || out.length >= max) return
    const abs = path.join(dir, rel)
    if (fs.existsSync(abs) && !out.some(o => o.abs === abs)) out.push({ abs, why })
  }
  // One image per defect (its lead evidence), in the report's order.
  for (const d of devicesJson.defects ?? []) add(d.shot, `${d.id} · ${d.title} · ${d.screens[0]}`)
  if (out.length) return out
  // No findings: one figure per case, its last step (where the proof usually is).
  const results = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf-8'))
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.at(-1)
        const figs = (last?.attachments ?? []).filter(a => a.contentType === 'image/png' && a.path && !a.name.endsWith(' · raw') && a.name !== 'end of test')
        const fig = figs.at(-1)
        if (fig && last.status === 'passed') add(path.relative(dir, fig.path), spec.title)
      }
    }
    for (const c of suite.suites ?? []) walk(c)
  }
  for (const s of results.suites ?? []) walk(s)
  return out
}

/**
 * Build the publish payload locally. Nothing leaves the machine.
 * @param {{ ticket: string, env?: string, run?: string, video?: boolean, maxImages?: number }} opts
 */
export async function preparePublish ({ ticket, env: envName = DEFAULT_ENV, run, video = true, maxImages = 6, scopeNote }) {
  const env = knownEnv(envName)
  if (!env?.evidenceDir) return { ok: false, error: `Environment "${envName}" records no evidence.` }
  const dir = resolveRunDir(env, ticket, run)
  if (!dir) return { ok: false, error: `No ${run ? `run "${run}"` : 'run'} recorded for ${ticket} on ${env.name}.` }
  const runId = path.basename(dir)

  // Refresh EVIDENCE.md first: the report reads the tested systems from it,
  // and tickets/<T>/report.json may have been added since the run.
  await runInHarness('node', ['scripts/build-report.mjs', ticket, env.harnessEnv, runId], { timeoutMs: 60_000 })
  const report = await buildDeviceReport({ ticket, env: env.name, run: runId, scopeNote })
  if (!report.ok) return { ok: false, error: `Report could not be built: ${report.error}` }
  const devicesJson = JSON.parse(fs.readFileSync(path.join(dir, 'devices.json'), 'utf-8'))

  const out = path.join(dir, 'publish')
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  const base = `${ticket}_${env.name}_${runId}`
  const files = []
  const notes = []

  // 1. Report PDF
  const pdf = path.join(out, `${base}_report.pdf`)
  const pr = await runInHarness('node', ['scripts/report-pdf.mjs', ticket, env.harnessEnv, runId, pdf], { timeoutMs: 120_000 })
  if (pr.code !== 0 || !fs.existsSync(pdf)) return { ok: false, error: 'PDF export failed', detail: (pr.stderr || pr.stdout).slice(-500) }
  files.push({ kind: 'report', path: pdf })

  // 2. Evidence images
  const images = pickImages(dir, devicesJson, maxImages)
  images.forEach((img, i) => {
    const dest = path.join(out, `${base}_evidence-${String(i + 1).padStart(2, '0')}-${slug(img.why)}.png`)
    fs.copyFileSync(img.abs, dest)
    files.push({ kind: 'image', path: dest, caption: img.why })
  })

  // 3. Video: Linear plays MP4 (H.264); the reel is WebM.
  const reel = path.join(dir, 'report.webm')
  const enc = video ? (await checkToolkit({ features: ['publish'] })).missing.find(m => m.id === 'ffmpeg-libx264') : null
  if (enc) notes.push(`Video not attached: ${enc.label} is missing (${enc.command}).`)
  if (video && !enc && fs.existsSync(reel)) {
    const mp4 = path.join(out, `${base}_video.mp4`)
    const r = await ffmpeg(['-y', '-v', 'error', '-i', reel, '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4])
    if (r.code === 0 && fs.existsSync(mp4)) {
      if (fs.statSync(mp4).size > MAX_VIDEO_MB * 1_048_576) {
        notes.push(`Video is ${mb(fs.statSync(mp4).size)} MB, over the ${MAX_VIDEO_MB} MB cap; not attached.`)
        fs.rmSync(mp4)
      } else files.push({ kind: 'video', path: mp4 })
    } else notes.push(`Video conversion failed (${r.stderr.split('\n')[0]}); not attached.`)
  } else if (video) notes.push('No narrated video for this run (run with demo to record one).')

  // 4. Comment (Markdown). Images are embedded as ![caption](<asset>), the PDF and
  // the MP4 linked; the {{name}} placeholders become Linear asset URLs on publish.
  const t = devicesJson.totals
  const passed = t.runs - t.failed - t.skipped
  const label = { 'breaks found': 'Defects found', 'passed with warnings': 'Passed with minor items', 'no breaks found': 'Passed' }[devicesJson.verdict] ?? devicesJson.verdict
  const icon = devicesJson.verdict === 'no breaks found' ? '✅' : devicesJson.verdict === 'breaks found' ? '❌' : '⚠️'
  const screens = devicesJson.devices.map(d => d.label)
  const L = []
  L.push(`### ${icon} Automated test run · ${md(env.label ?? env.name)} · ${md(label)}`)
  L.push(`**Run** ${runId} · **Cases** ${t.cases} · **Screens** ${screens.length} (${md(screens.join(', '))}) · **Passed** ${passed} of ${t.runs}${t.failed ? ` · **Failed** ${t.failed}` : ''}${t.skipped ? ` · **Skipped** ${t.skipped}` : ''}`)
  if (devicesJson.testedAgainst) L.push(`**Tested against** ${md(devicesJson.testedAgainst)}${devicesJson.context ? ` · ${md(devicesJson.context)}` : ''}`)
  L.push('')
  // One line per case: lists render the same everywhere Linear shows a comment.
  const cols = devicesJson.devices.slice(0, 8)
  for (const row of devicesJson.matrix) {
    const cells = cols.map((d) => {
      const r = row.results[d.name]
      if (!r) return null
      const st = r.status === 'passed' ? '✅' : r.status === 'skipped' ? '⏭️' : '❌'
      const lay = r.layout && r.layout !== 'layout ok' && r.layout !== 'not audited' ? ` (${md(r.layout.replace(/^[✗⚠] /, ''))})` : ''
      return `${st} ${md(d.label)}${lay}`
    }).filter(Boolean)
    L.push(`- **${md(row.case)}** — ${cells.join(' · ')}`)
  }
  if (devicesJson.devices.length > 8) L.push(`- _${devicesJson.devices.length - 8} more screens in the report PDF._`)
  const defects = devicesJson.defects ?? []
  L.push('')
  if (devicesJson.assessment) L.push(`**Assessment:** ${md(devicesJson.assessment)} _(rule in the report's method section)_`)
  if (scopeNote) L.push(`**Not run in this run:** ${md(scopeNote.split('\n').filter(Boolean).join('; '))}`)
  if (defects.length) {
    L.push('', '**Defects**')
    for (const d of defects) {
      const where = d.screens.length > 3 ? `${d.screens.length} screens (${d.screens.slice(0, 2).join(', ')}, …)` : d.screens.join(', ')
      L.push(`- **${d.id}** · ${d.severity === 'High' ? '🔴 High' : d.severity === 'Medium' ? '🟠 Medium' : '🔵 Low'} · ${md(d.title)} — ${md(where)}`)
    }
  } else L.push('**Defects:** none.')
  L.push('')
  const linked = files.filter(f => f.kind !== 'image').map(f => `[${f.kind === 'report' ? 'Report (PDF)' : 'Narrated video (MP4)'}]({{${path.basename(f.path)}}})`)
  if (linked.length) L.push(`**Files:** ${linked.join(' · ')}`)
  for (const f of files.filter(x => x.kind === 'image')) {
    L.push('', `**${md(f.caption)}**`, `![${md(f.caption)}]({{${path.basename(f.path)}}})`)
  }
  L.push('', `_Automated run ${runId} (ft-e2e). ${screens.length > 1 ? 'Screens are Playwright device emulation; iPhone/iPad columns run in Chromium unless marked Safari (WebKit). ' : ''}Results reflect this run only; the PDF has the method, assumptions and full evidence._`)
  let comment = L.join('\n')
  if (EMAIL().test(comment)) {
    comment = comment.replace(EMAIL(), '[email removed]')
    notes.push('An email address appeared in a test title or finding; it was removed from the comment.')
  }
  notes.push('Look at every image before posting: shareable (synthetic / E2E test account) data only, per SKILLS/run-app/references/capture.md.')

  const fileRecs = files.map(f => ({ ...f, name: path.basename(f.path), bytes: fs.statSync(f.path).size, sha256: sha(fs.readFileSync(f.path)) }))
  const digest = sha(JSON.stringify({ ticket, comment, files: fileRecs.map(f => [f.name, f.sha256]) })).slice(0, 16)
  if (fileRecs.length > maxImages + 2) notes.push('More files than expected; check the list.')
  const manifest = { ticket, env: env.name, run: runId, api: LINEAR_API, comment, files: fileRecs, digest, preparedAt: new Date().toISOString(), notes }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(path.join(out, 'comment.txt'), comment)

  const already = fs.existsSync(path.join(dir, 'published.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'published.json'), 'utf-8')) : null
  return {
    ok: true,
    ticket,
    env: env.name,
    run: runId,
    target: `Linear issue ${ticket}`,
    digest,
    files: fileRecs.map(f => ({ name: f.name, kind: f.kind, sizeMb: mb(f.bytes), caption: f.caption ?? null })),
    totalMb: mb(fileRecs.reduce((n, f) => n + f.bytes, 0)),
    comment,
    notes,
    alreadyPublished: already ? { at: already.publishedAt, comment: already.commentUrl } : null,
    credentials: credentialStatus(),
    folder: out,
  }
}

async function gql (key, query, variables) {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  })
  const json = await res.json().catch(() => null)
  const error = json?.errors?.[0]?.message ?? (res.ok ? null : `HTTP ${res.status}`)
  return { ok: res.ok && !json?.errors?.length, status: res.status, data: json?.data ?? null, error }
}

/** One file: fileUpload -> PUT to the signed URL (60 s) -> its unsigned assetUrl. */
async function uploadFile (key, f) {
  const contentType = CONTENT_TYPE[path.extname(f.name)] ?? 'application/octet-stream'
  const r = await gql(key, `mutation($contentType: String!, $filename: String!, $size: Int!) {
    fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }`,
  { contentType, filename: f.name, size: f.bytes })
  const up = r.data?.fileUpload?.uploadFile
  if (!r.ok || !up) return { ok: false, error: `fileUpload for ${f.name}: ${r.error ?? 'no upload URL'}` }
  const headers = { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000' }
  for (const h of up.headers ?? []) headers[h.key] = h.value
  const put = await fetch(up.uploadUrl, { method: 'PUT', headers, body: fs.readFileSync(f.path), signal: AbortSignal.timeout(5 * 60_000) })
    .catch(err => ({ ok: false, status: 0, statusText: err.message }))
  if (!put.ok) return { ok: false, error: `PUT ${f.name}: HTTP ${put.status}${put.status === 403 ? ' (a header was missing or the signed URL expired)' : ''}` }
  return { ok: true, assetUrl: up.assetUrl }
}

/**
 * Upload a prepared payload. Requires the digest preparePublish returned.
 * @param {{ ticket: string, env?: string, run?: string, digest: string, force?: boolean }} opts
 */
export async function publishToLinear ({ ticket, env: envName = DEFAULT_ENV, run, digest, force = false }) {
  const env = knownEnv(envName)
  const dir = env ? resolveRunDir(env, ticket, run) : null
  if (!dir) return { ok: false, error: `No run found for ${ticket} on ${envName}.` }
  const mf = path.join(dir, 'publish', 'manifest.json')
  if (!fs.existsSync(mf)) return { ok: false, error: 'Nothing prepared for this run. Call prepare_linear_publish first.' }
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf-8'))
  if (manifest.ticket !== ticket) return { ok: false, error: `Prepared payload is for ${manifest.ticket}, not ${ticket}.` }
  if (!digest || digest !== manifest.digest) {
    return { ok: false, error: 'Digest does not match the prepared payload. Re-run prepare_linear_publish, review it, and pass its digest.' }
  }
  for (const f of manifest.files) {
    if (!fs.existsSync(f.path) || sha(fs.readFileSync(f.path)) !== f.sha256) return { ok: false, error: `${f.name} changed since it was prepared. Prepare again.` }
  }
  const pubFile = path.join(dir, 'published.json')
  if (fs.existsSync(pubFile) && !force) {
    const p = JSON.parse(fs.readFileSync(pubFile, 'utf-8'))
    return { ok: false, error: `Run ${manifest.run} was already posted to ${p.ticket} at ${p.publishedAt} (${p.commentUrl}). Pass force to post again.` }
  }
  const key = apiKey()
  if (!key) return { ok: false, error: 'No Linear API key.', fix: credentialStatus().fix }

  const issue = await gql(key, 'query($id: String!) { issue(id: $id) { id identifier title url } }', { id: ticket })
  if (!issue.ok || !issue.data?.issue) {
    return { ok: false, error: issue.status === 401 || /auth/i.test(issue.error ?? '') ? 'Linear rejected the API key. Check the Keychain entry.' : `Cannot read ${ticket}: ${issue.error ?? 'not found'}` }
  }
  const { id: issueId, url: issueUrl } = issue.data.issue

  // One file per round trip: the signed URLs expire in 60 seconds.
  const uploaded = []
  for (const f of manifest.files) {
    const u = await uploadFile(key, f)
    if (!u.ok) return { ok: false, error: `${u.error}. No comment was posted.`, uploaded }
    const a = await gql(key, `mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success attachment { id } } }`,
      { input: { issueId, url: u.assetUrl, title: f.caption ?? f.name, subtitle: `ft-e2e run ${manifest.run} · ${manifest.env}` } })
    uploaded.push({ name: f.name, assetUrl: u.assetUrl, attachmentId: a.data?.attachmentCreate?.attachment?.id ?? null, attachmentError: a.ok ? undefined : a.error })
  }

  let body = manifest.comment
  for (const u of uploaded) body = body.split(`{{${u.name}}}`).join(u.assetUrl)
  const c = await gql(key, `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }`,
    { input: { issueId, body } })
  if (!c.ok || !c.data?.commentCreate?.success) return { ok: false, error: `Files uploaded but the comment failed: ${c.error}`, uploaded: uploaded.map(({ assetUrl, ...u }) => u) }

  const record = {
    ticket, run: manifest.run, env: manifest.env, digest,
    commentId: c.data.commentCreate.comment.id, commentUrl: c.data.commentCreate.comment.url,
    attachments: uploaded.map(({ assetUrl, ...u }) => u), publishedAt: new Date().toISOString(),
  }
  fs.writeFileSync(pubFile, JSON.stringify(record, null, 2))
  return { ok: true, ...record, issueUrl }
}
