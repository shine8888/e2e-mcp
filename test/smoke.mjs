// Speaks raw MCP over stdio to our own server: proves it boots, registers the
// expected tools, and that the read-only ones return real data against the
// real harness. Nothing here starts a test run; the checks on recordings, API
// evidence and device reports read the login-free smoke runs and say how to
// create them when they are missing.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const child = spawn(process.execPath, ['src/index.mjs'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })

let buf = ''
const pending = new Map()
let nextId = 1
child.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  let idx
  // eslint-disable-next-line no-cond-assign
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id) }
  }
})
child.stderr.on('data', d => console.error('[server stderr]', d.toString()))

function send (method, params) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, { resolve })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
const call = async (name, args = {}) => {
  const res = await send('tools/call', { name, arguments: args })
  return { text: res.result?.content?.[0]?.text ?? JSON.stringify(res), isError: !!res.result?.isError }
}

const EXPECTED = [
  'list_environments', 'preflight', 'prepare', 'run_e2e', 'build_report',
  'dev_stack_status', 'dev_stack_up', 'dev_stack_down',
  'inspect_page', 'get_evidence', 'list_tickets',
  'list_videos', 'build_demo_video', 'get_api_calls', 'list_runs',
  'list_devices', 'build_device_report',
  'prepare_linear_publish', 'publish_to_linear', 'linear_publish_status',
  'check_toolkit', 'install_toolkit',
]

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function main () {
  await send('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  const list = await send('tools/list', {})
  const names = list.result.tools.map(t => t.name)
  check(`registers ${EXPECTED.length} tools`, EXPECTED.every(n => names.includes(n)), names.join(', '))
  check('no tool description still talks about ImportGenius',
    !list.result.tools.some(t => /ig-e2e|importgenius|iscanv2|Auth0|Sphinx|IGDEV|codeninja/i.test(JSON.stringify(t))))
  const leftovers = list.result.tools.filter(t => /roomstay|obelisk|cognito|booking engine|hotel|jira|atlassian|staging|rs-e2e/i.test(JSON.stringify(t))).map(t => t.name)
  check('no tool description still talks about RoomStay (Cognito, hotels, Jira, staging)', leftovers.length === 0, leftovers.join(', '))

  const envs = JSON.parse((await call('list_environments')).text)
  check('list_environments returns the Fintary registry (local, dev, uat wired; preview and prod probe-only)',
    envs.length === 5 && envs.filter(e => e.wired).map(e => e.name).join(',') === 'local,dev,uat'
      && envs.find(e => e.name === 'dev').webURL === 'https://dev.fintary.com/' && envs.find(e => e.name === 'preview').firebaseProject === 'fintary-prod')

  const tickets = await call('list_tickets')
  check('list_tickets answers', !tickets.isError || /No tickets\/ directory/.test(tickets.text))

  const status = await call('dev_stack_status')
  check('dev_stack_status runs dev-up.sh', /web :3001 .* api :3000 .* postgres :5431/i.test(status.text))

  const pre = await call('preflight', { env: 'local' })
  const preJson = JSON.parse(pre.text)
  check('preflight on local reports checks, the fintary stamp and the repo\'s own safety preflight',
    preJson.checks.length > 0 && preJson.stamps.length === 1 && /^fintary: /.test(preJson.stamps[0]) && preJson.checks.some(c => /safety preflight/.test(c.name)),
    `canRun=${preJson.canRun}`)
  const preApp = JSON.parse((await call('preflight', { env: 'dev', ticket: '_app-smoke' })).text)
  const preWeb = JSON.parse((await call('preflight', { env: 'dev', ticket: '_web-smoke' })).text)
  check('preflight knows which tickets need a signed-in user (the sign-in page needs none)',
    preApp.needsLogin === true && preWeb.needsLogin === false
      && !preWeb.blocking.some(b => /test user|cached session/.test(b)))
  check('preflight on dev stamps what is live (API image commit, web build time)',
    preWeb.stamps.some(x => /^live api image from [0-9a-f]{10}$/.test(x)) && preWeb.stamps.some(x => /^live web built \d{4}-/.test(x)), preWeb.stamps.join(' | '))

  for (const env of ['preview', 'prod']) {
    const unwired = await call('run_e2e', { env, ticket: '_web-smoke' })
    check(`run_e2e refuses an unwired environment (${env}: production data)`, unwired.isError && /not wired/.test(unwired.text))
  }

  const unscoped = await call('run_e2e', { env: 'dev' })
  check('run_e2e refuses an unscoped run', unscoped.isError && /unscoped/.test(unscoped.text))

  const report = await call('build_report')
  const reportJson = JSON.parse(report.text)
  check('build_report writes md + html + json', reportJson.written.length === 3, `${reportJson.runsFound} runs`)

  // Recordings: _demo-smoke is the login-free narrated spec.
  const smokeRuns = await call('list_runs', { ticket: '_demo-smoke', env: 'dev' })
  const runIds = smokeRuns.isError ? [] : JSON.parse(smokeRuns.text).runs.map(r => r.run)
  let vids = { isError: true, text: '' }
  for (const run of runIds) {
    const v = await call('list_videos', { ticket: '_demo-smoke', env: 'dev', run })
    if (!v.isError && JSON.parse(v.text).tests.some(t => t.demoRecorded)) { vids = { ...v, run }; break }
  }
  if (vids.isError) {
    console.log('  skip  list_videos / build_demo_video — no narrated _demo-smoke run yet; create one with:\n'
      + '        node bin/ft-e2e-run.mjs run --ticket _demo-smoke --demo --skip-preflight')
  } else {
    const v = JSON.parse(vids.text)
    check('list_videos finds a demo recording', v.withVideo > 0 && v.tests.some(t => t.demoRecorded))
    const ev = JSON.parse((await call('get_evidence', { ticket: '_demo-smoke', env: 'dev', run: vids.run, includeNotes: true })).text)
    check('get_evidence summarizes the run and its EVIDENCE.md stamps the fintary web', /"headline"/.test(JSON.stringify(ev)) && /\| Web \| `fintary\/services\/web` — /.test(ev.evidenceNotes ?? ''))
    const reel = await call('build_demo_video', { ticket: '_demo-smoke', env: 'dev', run: vids.run })
    const r = JSON.parse(reel.text)
    check('build_demo_video stitches a 1600x1000 reel with chapters',
      !reel.isError && r.width === 1600 && r.chapters.length >= 3, `${r.durationSec}s, ${r.sizeMb} MB`)
  }

  // API evidence: _api-smoke is the login-free API spec (local stub server).
  const calls = await call('get_api_calls', { ticket: '_api-smoke', env: 'dev', withBodies: true })
  if (calls.isError) {
    console.log('  skip  get_api_calls — no _api-smoke run yet; create one with:\n'
      + '        node bin/ft-e2e-run.mjs run --ticket _api-smoke --api --skip-preflight')
  } else {
    const c = JSON.parse(calls.text)
    check('get_api_calls reads recorded calls', c.totalCalls === 3 && c.failedCalls === 1, `${c.totalCalls} calls`)
    check('recorded API evidence carries no raw email, password, token or card number',
      !/agent@example-agency|hunter2|eyJhbGci|4242424242424242|415 555/.test(calls.text) && /\[redacted\]/.test(calls.text) && /stub-trace-0001/.test(calls.text))
  }

  // Per-run history: every run keeps its own date-time folder.
  const runs = await call('list_runs', { ticket: '_api-smoke', env: 'dev' })
  if (!runs.isError) {
    const r = JSON.parse(runs.text)
    check('list_runs keeps each run in its own date-time folder',
      r.runs.every(x => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(x.run)), `${r.count} run(s)`)
  }

  // Multi-device: the registry, and the planted faults in tests/_device-smoke
  // (a 640px table -> break on the 412px phone only; an 18px button -> warning
  // on touch screens only).
  const devList = JSON.parse((await call('list_devices')).text)
  const devs = devList.screens
  check('list_devices reads harness/lib/devices.ts: default desktop/tablet/mobile, iPhone and Galaxy groups',
    devs.filter(d => d.default).map(d => d.name).join(',') === 'desktop,tablet,mobile'
      && devList.groups.iphones?.includes('iphone-15') && devList.groups.android?.includes('galaxy-s24')
      && Object.values(devList.groups).flat().every(n => devs.some(d => d.name === n)) && devs.length >= 22,
    `${devs.length} screens, ${Object.keys(devList.groups).length} groups`)
  const dev = await call('build_device_report', { ticket: '_device-smoke', env: 'dev' })
  if (dev.isError && /No run recorded/.test(dev.text)) {
    console.log('  skip  build_device_report — no _device-smoke run yet; create one with:\n'
      + '        node bin/ft-e2e-run.mjs run --ticket _device-smoke --devices --skip-preflight')
  } else {
    const r = JSON.parse(dev.text)
    const row = r.matrix?.[0] ?? {}
    check('build_device_report finds the planted mobile break and nothing on desktop',
      !dev.isError && r.verdict === 'breaks found' && /sideways overflow/.test(row.mobile) && /layout ok/.test(row.desktop) && /small touch target/.test(row.tablet)
        && r.issues.some(i => i.device === 'mobile' && /table/.test(i.elements?.[0] ?? '')),
      `${r.verdict}`)
    check('device report writes a paste-ready team update with no local-only claims of attachments',
      /multi-device test/.test(r.teamUpdate ?? '') && /devices\.html/.test(r.teamUpdate ?? ''))
  }
  const notDevice = await call('build_device_report', { ticket: '_api-smoke', env: 'dev' })
  check('build_device_report explains a run with no browser tests (API-only)', notDevice.isError && /no browser tests|No run/.test(notDevice.text))
  const br = devList.browsers ?? []
  check('list_devices lists chromium/chrome/edge/firefox/safari with install status, safari marked as WebKit',
    ['chromium', 'chrome', 'edge', 'firefox', 'safari'].every(n => br.some(b => b.name === n && typeof b.installed === 'boolean'))
      && /WebKit/.test(br.find(b => b.name === 'safari')?.what ?? ''))
  const badBrowser = await call('run_e2e', { env: 'dev', ticket: '_device-smoke', browsers: ['netscape'] })
  check('run_e2e rejects an unknown browser', badBrowser.isError)
  const badDevice = await call('run_e2e', { env: 'dev', ticket: '_device-smoke', devices: ['fridge'] })
  check('run_e2e rejects an unknown device', badDevice.isError)

  // Linear publishing: prepare is local-only; publish must refuse without the
  // reviewed digest. Neither check touches Linear.
  const prep = await call('prepare_linear_publish', { ticket: '_device-smoke', env: 'dev', video: false, maxImages: 2 })
  if (!prep.isError) {
    const p = JSON.parse(prep.text)
    check('prepare_linear_publish builds a PDF and a Markdown comment locally, images as asset placeholders, with a digest',
      p.files.some(f => f.kind === 'report' && f.name.endsWith('.pdf')) && /^### .*Automated test run/.test(p.comment) && /!\[[^\]]*\]\(\{\{[^}]+\.png\}\}\)/.test(p.comment)
        && /^[0-9a-f]{16}$/.test(p.digest) && /Linear issue _device-smoke/.test(p.target),
      `${p.files.length} file(s), ${p.totalMb} MB`)
    const noDigest = await call('publish_to_linear', { ticket: '_device-smoke', env: 'dev', digest: 'not-the-digest' })
    check('publish_to_linear refuses a payload the user did not review (wrong digest)', noDigest.isError && /Digest does not match/.test(noDigest.text))
  } else console.log(`  skip  prepare_linear_publish — ${prep.text.slice(0, 160)}`)
  const linStatus = JSON.parse((await call('linear_publish_status')).text)
  check('linear_publish_status never returns a key', !('key' in linStatus) && !/lin_api_|[A-Za-z0-9_-]{30,}/.test(JSON.stringify(linStatus).replace(/https?:\S+/g, '')))

  // Toolkit doctor: every row has an id and, when missing, a fix with a kind
  // and a command; secrets, admin installs and Docker are never "auto".
  const tk = JSON.parse((await call('check_toolkit', {})).text)
  check('check_toolkit reports each feature and a fix for every missing item',
    ['core', 'dev', 'uat', 'local', 'demo', 'browsers', 'publish'].every(f => f in tk.features)
      && tk.missing.every(m => ['auto', 'manual'].includes(m.kind) && m.command)
      && tk.missing.filter(m => ['edge', 'chrome', 'linear-key', 'docker', 'env-local', 'env-dev', 'env-uat'].includes(m.id)).every(m => m.kind === 'manual'),
    `${tk.missing.length} missing: ${tk.missing.map(m => m.id).join(', ') || 'none'}`)

  const apiOnlyReel = await call('build_demo_video', { ticket: '_api-smoke', env: 'dev' })
  check('build_demo_video explains a run with no recordings', apiOnlyReel.isError && /no recorded videos|No run recorded/.test(apiOnlyReel.text))

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  child.kill()
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error(e); child.kill(); process.exit(1) })
