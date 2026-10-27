#!/usr/bin/env node
// Standalone CLI over the same scenario functions the MCP server exposes.
// Anything you can ask the MCP server to do, you can do here in a terminal --
// and both go through one implementation, so they cannot report differently.
import { DEFAULT_ENV, ENVIRONMENTS, ENV_NAMES } from '../src/env.mjs'
import { verdictOf } from '../src/scenarios/summarize.mjs'
import { preflight } from '../src/scenarios/preflight.mjs'
import { prepare } from '../src/scenarios/prepare.mjs'
import { run } from '../src/scenarios/run.mjs'
import { report } from '../src/scenarios/report.mjs'
import { buildDemoVideo, listVideos } from '../src/scenarios/video.mjs'
import { apiCalls } from '../src/scenarios/api-calls.mjs'
import { listRuns } from '../src/scenarios/runs.mjs'
import { knownEnv } from '../src/env.mjs'
import { summarizeRun as summarizeOne, oneLine as lineOf } from '../src/scenarios/summarize.mjs'
import { buildDeviceReport, DEFAULT_DEVICES, listBrowsers, listDeviceGroups, listDevices } from '../src/scenarios/devices.mjs'
import { preparePublish, publishToLinear } from '../src/scenarios/publish.mjs'
import { checkToolkit, installToolkit } from '../src/scenarios/toolkit.mjs'

const argv = process.argv.slice(2)
const command = argv.find(a => !a.startsWith('-')) ?? 'help'
const has = name => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const asJson = has('json')

const env = opt('env', DEFAULT_ENV)
const ticket = opt('ticket')
const runSel = opt('run')
const grep = opt('grep')
const timeoutMs = opt('timeout') ? Number(opt('timeout')) : undefined
// --devices                  -> desktop,tablet,mobile
// --devices all              -> every screen in harness/lib/devices.ts
// --devices desktop,mobile   -> exactly those
// --browsers chromium,chrome,edge,firefox,safari | all
const browsersOpt = has('browsers') ? (opt('browsers') && !opt('browsers').startsWith('-') ? opt('browsers').split(',').map(x => x.trim()) : ['all']) : []
const devicesOpt = (() => {
  if (!has('devices')) return []
  const v = opt('devices')
  if (!v || v.startsWith('-')) return DEFAULT_DEVICES
  // Names and group names pass through; the harness expands groups (lib/devices.ts).
  return v.split(',').map(x => x.trim()).filter(Boolean)
})()

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
}
const mark = ok => (ok ? C.green('  ok  ') : C.red(' FAIL '))

function usage () {
  console.log(`ft-e2e-run — drive the Fintary e2e harness (web app + API) across environments

  usage: node bin/ft-e2e-run.mjs <command> [options]

  commands:
    envs         list the environment registry
    preflight    read-only readiness check (changes nothing)
    prepare      install deps, start the local stack (scripts/agent/up.sh), sign in, then re-check
    run          run a suite (preflight-gated) and rebuild EVIDENCE.md
    report       roll every recorded run up into md/html/json
    runs         every recorded run of a ticket, newest first (needs --ticket)
    api-calls    list a run's recorded API calls (needs --ticket; --bodies for detail)
    videos       list a run's recordings (needs --ticket)
    demo-video   stitch a run into one report.webm (needs --ticket)
    full         prepare -> run -> report, stopping at the first blocker
                 (with --demo, also builds report.webm)
    devices      list the screens a multi-device run can cover
    device-report  rebuild a device run's DEVICES.md / devices.html / TEAM-UPDATE.md
    doctor       what each feature needs on this machine, what is missing, how to install it
    install      install the missing pieces that are safe to install (all, or: install pw-firefox pw-webkit)
    publish      prepare a run's Linear post (PDF, images, MP4, comment) and show it;
                 add --yes to upload it to the issue (needs --ticket)

  options:
    --env <name>       ${ENV_NAMES.join(' | ')}   (default: ${DEFAULT_ENV}; preview and prod are probe-only)
    --ticket <name>    ticket folder under harness/tests, e.g. PLT-1234 or _web-smoke
    --grep <pattern>   Playwright --grep filter
    --headed           show the browser
    --demo             narrated recording: step captions, action highlights,
                       chapter cards, 1600x1000 (forces headed)
    --interstitials    auto | always | never   per-test cards in demo-video
    --skip-preflight   run even if the gate reports blockers
    --api              run only *.api.spec.ts — no browser, API calls recorded as evidence
    --devices [list]   run every case per screen: no value = desktop,tablet,mobile;
                       "all"; or e.g. desktop,iphones,small. Builds the device report.
    --layout-strict    device runs: fail a case whose screen scrolls sideways
    --browsers [list]  run every case per browser: chromium,chrome,edge,firefox,safari
                       (no value = all = chromium,firefox,safari). Combines with --devices.
                       safari = WebKit, not Safari.app
    --grep-invert <p>  leave out matching cases (@writes cases are always left out unless --writes)
    --writes           also run cases tagged @writes (they create, change or delete data)
    --bodies           api-calls: include request/response bodies and curl
    --test <text>      api-calls: only tests whose title contains <text>
    --run <id>         videos / demo-video / api-calls: a run from \`runs\` (default: newest)
    --no-login-refresh run: stop on a dead session instead of signing in again
    --scope-note <text>  publish: cases deliberately not run, one per line with the reason
    --no-sign-in       prepare: do not sign in again when the session is dead
    --timeout <ms>     override the step timeout
    --json             machine-readable output
`)
}

function printPreflight (res) {
  console.log(`\n${C.bold(`preflight · ${res.env}`)} ${res.wired ? '' : C.yellow('(declared, not wired for runs)')}`)
  for (const c of res.checks) {
    const state = c.ok ? mark(true) : (c.blocking ? mark(false) : C.yellow(' warn '))
    console.log(`  ${state} ${c.name}\n         ${C.dim(c.detail)}`)
  }
  if (res.stamps?.length) {
    console.log(`\n  ${C.dim('under test:')}`)
    for (const s of res.stamps) console.log(`    ${C.dim(s)}`)
  }
  console.log(res.canRun
    ? `\n${C.green('ready to run')}\n`
    : `\n${C.red('blocked:')} ${res.blocking.join(' · ') || 'environment is not wired for runs'}\n`)
}

function printRun (res) {
  if (res.login) {
    console.log(`\n  ${res.login.ok ? C.green('login refreshed') : C.red('login refresh failed')} ${C.dim(`via ${res.login.how}, ${res.login.seconds}s`)}`)
  }
  if (!res.ok && res.stage === 'preflight') {
    console.log(`\n${C.red('run blocked by preflight')}${res.login ? ' — even after signing in again' : ''}`)
    for (const b of res.blocking) console.log(`  - ${b}`)
    console.log()
    return
  }
  if (res.error) { console.log(`\n${C.red('run failed')}: ${res.error}\n`); return }
  const head = res.ok ? C.green('PASS') : C.red('FAIL')
  console.log(`\n${C.bold(`run · ${res.ticket} · ${res.env}`)}  ${head}  ${res.headline}`)
  if (res.summary.failingTests.length) {
    console.log(`\n  ${C.red('failing:')}`)
    for (const t of res.summary.failingTests) console.log(`    - ${t.title} ${C.dim(`(${t.project})`)}`)
  }
  if (res.summary.incomplete) console.log(`  ${C.yellow('incomplete')} ${C.dim(`${res.summary.skipped} case(s) never ran — counted against the rate`)}`)
  if (res.runId) console.log(`\n  ${C.dim(`run ${res.runId} → ${res.runDir}`)}\n  ${C.dim(`latest → ${res.latestDir}`)}`)
  if (res.evidence) console.log(`  ${C.dim(`evidence: ${res.evidence.path}`)}`)
  if (res.browsersSkipped) for (const b of res.browsersSkipped) console.log(`  ${C.yellow('skipped')} ${b.browser}: ${b.reason}${b.install ? C.dim(` — ${b.install}`) : ''}`)
  if (res.deviceReport) printDeviceReport(res.deviceReport)
  console.log(`  ${C.dim(res.reportOpenCommand)}\n`)
}

function printDeviceReport (r) {
  if (!r.ok) { console.log(`\n  ${C.red('device report')}: ${r.error}`); return }
  const tone = r.verdict === 'no breaks found' ? C.green : r.verdict === 'breaks found' ? C.red : C.yellow
  console.log(`\n  ${C.bold('devices')}  ${tone(r.verdict)}  ${C.dim(`${r.totals.cases} case(s) × ${r.devices.length} screens · ${r.totals.failed} failed · ${r.totals.breaks} break(s) · ${r.totals.warnings} warning(s)`)}`)
  for (const d of r.devices) console.log(`    ${d.label.padEnd(36)} ${d.passed} passed  ${d.failed ? C.red(`${d.failed} failed`) : '0 failed'}  ${d.breaks ? C.red(`${d.breaks} break`) : '0 break'}  ${d.warns} warn`)
  for (const i of r.issues.slice(0, 8)) console.log(`    ${C.red('✗')} ${i.device} — ${i.case}: ${i.detail}${i.elements?.[0] ? C.dim(` · ${i.elements[0]}`) : ''}`)
  console.log(`  ${C.dim(`report: ${r.files.html}`)}\n  ${C.dim(`team update: ${r.files.teamUpdate}`)}`)
}

function printVideos (res) {
  if (!res.ok) { console.log(`\n${C.red('videos')}: ${res.error}\n`); return }
  console.log(`\n${C.bold(`videos · ${res.ticket} · ${res.env}`)}  ${res.withVideo} recorded, ${res.withoutVideo} without`)
  for (const t of res.tests) {
    const tag = t.video
      ? `${t.width}x${t.height} · ${t.durationSec}s${t.demoRecorded ? C.green(' · demo') : ''}`
      : C.yellow('no video')
    console.log(`  ${t.status === 'passed' ? C.green('PASS') : C.red(t.status.toUpperCase())}  ${t.title}\n        ${C.dim(tag)}${t.video ? `\n        ${C.dim(t.video)}` : ''}`)
  }
  console.log(res.demoReel
    ? `\n  ${C.bold('report video')} ${C.dim(`${res.demoReel.durationSec}s · ${res.demoReel.path}`)}\n`
    : `\n  ${C.dim('no report video yet — node bin/ft-e2e-run.mjs demo-video --ticket ' + res.ticket + ' --env ' + res.env)}\n`)
}

function printDemoVideo (res) {
  if (!res.ok) { console.log(`\n${C.red('demo-video failed')}: ${res.error}${res.detail ? `\n${C.dim(res.detail)}` : ''}\n`); return }
  console.log(`\n${C.bold(`report video · ${res.ticket} · ${res.env}`)}  ${C.green('built')}  ${res.durationSec}s · ${res.width}x${res.height} · ${res.sizeMb} MB ${C.dim(`(encoded in ${res.encodeSec}s)`)}`)
  console.log(`\n  ${C.dim('chapters:')}`)
  for (const c of res.chapters) console.log(`    ${C.dim('›')} ${c}`)
  if (res.testsWithoutVideo.length) console.log(`\n  ${C.yellow('left out (no recording):')} ${res.testsWithoutVideo.join(' · ')}`)
  console.log(`\n  ${res.openCommand}\n`)
}

function printReport (res) {
  console.log(`\n${C.bold('report')} · ${res.runsFound} recorded run(s)`)
  for (const t of res.totals) {
    const rate = t.passRate === null ? 'n/a' : `${Math.round(t.passRate * 100)}%`
    const colour = { good: C.green, warn: C.yellow, bad: C.red }[verdictOf(t)]
    console.log(`  ${colour(rate.padStart(4))}  ${t.label.padEnd(16)} ${C.dim(`${t.expected} passed · ${t.unexpected} failed · ${t.flaky} flaky · ${t.skipped} skipped · ${t.tickets} ticket(s)`)}`)
  }
  console.log(`\n  ${C.dim('written:')}`)
  for (const f of res.written) console.log(`    ${C.dim(f)}`)
  console.log()
}

const out = (value, printer) => {
  if (asJson) console.log(JSON.stringify(value, null, 2))
  else printer(value)
}

switch (command) {
  case 'envs': {
    if (asJson) { console.log(JSON.stringify(ENVIRONMENTS, null, 2)); break }
    console.log(`\n${C.bold('environments')}`)
    for (const e of ENVIRONMENTS) {
      console.log(`  ${e.wired ? C.green('wired ') : C.yellow('declared')}  ${e.name.padEnd(11)} ${e.webURL}${C.dim(`  api ${e.apiURL}`)}`)
      console.log(`            ${C.dim(e.notes)}`)
    }
    console.log()
    break
  }
  case 'preflight': {
    const res = await preflight({ env, ticket })
    out(res, printPreflight)
    process.exit(res.canRun ? 0 : 1)
    break
  }
  case 'prepare': {
    const res = await prepare({
      env, ticket, timeoutMs, signIn: !has('no-sign-in'),
    })
    if (asJson) { console.log(JSON.stringify(res, null, 2)); break }
    console.log(`\n${C.bold(`prepare · ${env}`)}`)
    for (const a of res.actions) console.log(`  ${mark(a.ok)} ${a.step}\n         ${C.dim(String(a.detail).split('\n').join('\n         '))}`)
    if (res.manual.length) {
      console.log(`\n  ${C.yellow('manual steps left for you:')}`)
      for (const m of res.manual) console.log(`    - ${m}`)
    }
    printPreflight(res.preflight)
    process.exit(res.ok ? 0 : 1)
    break
  }
  case 'run': {
    const res = await run({
      env,
      ticket,
      grep,
      headed: has('headed'),
      demo: has('demo'),
      apiOnly: has('api'),
      devices: devicesOpt,
      browsers: browsersOpt,
      grepInvert: opt('grep-invert'),
      writes: has('writes'),
      layoutStrict: has('layout-strict'),
      refreshLogin: !has('no-login-refresh'),
      skipPreflight: has('skip-preflight'),
      timeoutMs,
    })
    out(res, printRun)
    process.exit(res.ok ? 0 : 1)
    break
  }
  case 'report': {
    const res = await report({})
    out(res, printReport)
    break
  }
  case 'api-calls': {
    if (!ticket) { console.log('api-calls needs --ticket'); process.exit(2) }
    const res = apiCalls({ ticket, env, run: runSel, test: opt('test'), withBodies: has('bodies') })
    if (asJson || has('bodies')) { console.log(JSON.stringify(res, null, 2)); process.exit(res.ok ? 0 : 1) }
    if (!res.ok) { console.log(`\n${C.red('api-calls')}: ${res.error}\n`); process.exit(1) }
    console.log(`\n${C.bold(`api calls · ${res.ticket} · ${res.env}`)}  ${res.totalCalls} call(s), ${res.failedCalls ? C.red(`${res.failedCalls} failed`) : C.green('0 failed')}`
      + (res.anyFullBodies ? C.red('  · FULL bodies (E2E_API_FULL=1) — do not share') : ''))
    for (const t of res.tests) {
      console.log(`\n  ${t.status === 'passed' ? C.green('PASS') : C.red(t.status.toUpperCase())}  ${t.title}`)
      for (const c of t.calls) {
        const st = c.status === null ? C.red(`error ${c.error}`) : (c.status >= 400 ? C.red(String(c.status)) : C.green(String(c.status)))
        console.log(`    ${String(c.n).padStart(2)}. ${c.method.padEnd(6)} ${st.padEnd(12)} ${C.dim(`${String(c.ms).padStart(5)} ms`)}  ${c.path}`)
      }
    }
    if (res.note) console.log(`\n  ${C.dim(res.note)}`)
    console.log(`\n  ${C.dim('bodies + curl: add --bodies · full evidence: tickets/' + res.ticket + '/…/EVIDENCE.md')}\n`)
    break
  }
  case 'runs': {
    if (!ticket) { console.log('runs needs --ticket'); process.exit(2) }
    const envRec = knownEnv(env)
    const runs = envRec ? listRuns(envRec, ticket).reverse() : []
    if (asJson) { console.log(JSON.stringify(runs, null, 2)); break }
    console.log(`\n${C.bold(`runs · ${ticket} · ${env}`)}  ${runs.length} recorded`)
    for (const r of runs) {
      const s = summarizeOne(`${r.dir}/results.json`)
      const tag = s.passed && !s.incomplete ? C.green('PASS') : (s.passed ? C.yellow('INCOMPLETE') : C.red('FAIL'))
      console.log(`  ${r.id.padEnd(20)} ${tag}  ${lineOf(s)}\n  ${' '.repeat(20)} ${C.dim(r.dir)}`)
    }
    if (!runs.length) console.log(`  ${C.dim('none yet')}`)
    console.log()
    break
  }
  case 'videos': {
    if (!ticket) { console.log('videos needs --ticket'); process.exit(2) }
    const res = listVideos({ ticket, env, run: runSel })
    out(res, printVideos)
    process.exit(res.ok ? 0 : 1)
    break
  }
  case 'demo-video': {
    if (!ticket) { console.log('demo-video needs --ticket'); process.exit(2) }
    if (!asJson) console.log(C.dim('\nrendering cards and encoding — a few seconds per minute of footage…'))
    const res = await buildDemoVideo({ ticket, env, run: runSel, interstitials: opt('interstitials', 'auto') })
    out(res, printDemoVideo)
    process.exit(res.ok ? 0 : 1)
    break
  }
  case 'full': {
    const prep = await prepare({ env, ticket, signIn: !has('no-sign-in') })
    if (!asJson) {
      console.log(`\n${C.bold(`full · ${env}${ticket ? ` · ${ticket}` : ''}`)}`)
      for (const a of prep.actions) console.log(`  ${mark(a.ok)} ${a.step}`)
    }
    const loginOnly = prep.preflight?.blocking?.length
      && prep.preflight.blocking.every(b => b.startsWith('cached session') || b.startsWith('test user'))
    if (!prep.ok && loginOnly && !has('no-login-refresh')) {
      if (!asJson) console.log(`  ${C.yellow('session')} — signing in again through the web's form`)
    } else if (!prep.ok) {
      if (asJson) console.log(JSON.stringify({ stage: 'prepare', ...prep }, null, 2))
      else {
        console.log(`\n${C.red('stopped after prepare')} — ${prep.preflight.blocking.join(' · ')}`)
        for (const m of prep.manual) console.log(`  - ${m}`)
        console.log()
      }
      process.exit(1)
    }
    const runRes = await run({
      // run() gates again itself, so an expired login is refreshed there.
      env, ticket, grep, headed: has('headed'), demo: has('demo'), timeoutMs, refreshLogin: !has('no-login-refresh'),
      devices: devicesOpt, browsers: browsersOpt, grepInvert: opt('grep-invert'), writes: has('writes'), layoutStrict: has('layout-strict'),
      skipPreflight: has('skip-preflight'),
    })
    if (!asJson) printRun(runRes)
    let reel = null
    if (has('demo') && ticket && runRes.stage === 'complete') {
      reel = await buildDemoVideo({ ticket, env, run: runRes.runId })
      if (!asJson) printDemoVideo(reel)
      // Re-run so DEVICES.md links the reel that now exists.
      if (devicesOpt.length && reel.ok) await buildDeviceReport({ ticket, env, run: runRes.runId })
    }
    const rep = await report({})
    if (asJson) console.log(JSON.stringify({ prepare: prep, run: runRes, demoVideo: reel, report: rep }, null, 2))
    else printReport(rep)
    process.exit(runRes.ok ? 0 : 1)
    break
  }
  case 'devices': {
    const list = listDevices()
    if (asJson) { console.log(JSON.stringify(list, null, 2)); break }
    console.log(`\n${C.bold('screens')}  ${C.dim('(Playwright device emulation in Chromium — iPad/iPhone are not Safari unless --browsers safari)')}`)
    for (const d of list) console.log(`  ${(d.default ? C.green('●') : ' ')} ${d.name.padEnd(17)} ${d.label}  ${C.dim(d.descriptor)}`)
    console.log(`\n  ${C.dim('● = used by a bare --devices')}`)
    console.log(`\n${C.bold('browsers')}`)
    for (const b of listBrowsers()) console.log(`  ${b.installed ? C.green('●') : C.red('○')} ${b.name.padEnd(8)} ${b.label.padEnd(16)} ${C.dim(b.what)}${b.installed ? '' : C.red(`  not installed — ${b.install}`)}`)
    console.log(`\n${C.bold('groups')}`)
    for (const [g, ns] of Object.entries(listDeviceGroups())) if (g !== 'all') console.log(`  ${g.padEnd(10)} ${C.dim(ns.join(', '))}`)
    console.log(`\n  ${C.dim("no profile in the harness's Playwright 1.60: iPhone 16/17, Galaxy S25 — not emulated rather than guessed")}\n`)
    break
  }
  case 'device-report': {
    if (!ticket) { console.log('device-report needs --ticket'); process.exit(2) }
    const res = await buildDeviceReport({ ticket, env, run: runSel })
    out(res, printDeviceReport)
    process.exit(res.ok ? 0 : 1)
    break
  }
  case 'doctor': {
    const res = await checkToolkit({})
    if (asJson) { console.log(JSON.stringify(res, null, 2)); break }
    console.log(`\n${C.bold('toolkit')}`)
    for (const [f, v] of Object.entries(res.features)) {
      const note = v.missing.length ? (v.ready ? C.dim(`(optional, not installed: ${v.missing.join(', ')})`) : C.dim(v.missing.join(', '))) : ''
      console.log(`  ${v.ready ? C.green('ready  ') : C.red('missing')} ${f.padEnd(9)} ${note}`)
    }
    if (res.missing.length) {
      console.log(`\n${C.bold('to fix')}`)
      for (const m of res.missing) console.log(`  ${m.kind === 'auto' ? C.yellow('auto  ') : C.red('manual')} ${m.label}\n         ${C.dim(m.command)}`)
      if (res.canAutoInstall.length) console.log(`\n  ${C.dim(`the "auto" ones: node bin/ft-e2e-run.mjs install ${res.canAutoInstall.join(' ')}`)}`)
    } else if (!res.unchecked.length) console.log(`\n  ${C.green('everything is installed')}`)
    for (const u of res.unchecked) console.log(`  ${C.yellow('could not check')} ${u.label}: ${C.dim(u.detail)}`)
    console.log()
    break
  }
  case 'install': {
    const ids = argv.filter(a => !a.startsWith('-') && a !== 'install')
    if (!asJson) console.log(C.dim(`\ninstalling ${ids.length ? ids.join(', ') : 'every missing auto item'} — downloads can take a few minutes…`))
    const res = await installToolkit({ items: ids })
    if (asJson) { console.log(JSON.stringify(res, null, 2)); process.exit(res.ok ? 0 : 1) }
    for (const r of res.results) console.log(`  ${r.ran ? (r.ok ? C.green('done') : C.red('failed')) : C.yellow('manual')}  ${r.id}${r.command ? C.dim(`  ${r.command}`) : ''}${r.seconds ? C.dim(`  ${r.seconds}s`) : ''}`)
    for (const u of res.unknown) console.log(`  ${C.red('unknown')} ${u}`)
    console.log(`\n  ${res.ok ? C.green('everything is installed') : `still missing: ${res.after.missing.map(m => m.id).join(', ')}`}\n`)
    process.exit(res.ok ? 0 : 1)
  }
  case 'publish': {
    if (!ticket) { console.log('publish needs --ticket'); process.exit(2) }
    if (!asJson) console.log(C.dim('\nbuilding the PDF, images and video — about a minute with a video…'))
    const prep = await preparePublish({ ticket, env, run: runSel, video: !has('no-video'), scopeNote: opt('scope-note') })
    if (!prep.ok) { console.log(`\n${C.red('publish')}: ${prep.error}${prep.detail ? `\n${prep.detail}` : ''}\n`); process.exit(1) }
    if (!asJson) {
      console.log(`\n${C.bold(`publish preview · ${prep.ticket} · ${prep.env} · run ${prep.run}`)}  → ${prep.target}`)
      console.log(`\n  ${C.bold('files')} (${prep.totalMb} MB)`)
      for (const f of prep.files) console.log(`    ${f.kind.padEnd(6)} ${String(f.sizeMb).padStart(6)} MB  ${f.name}`)
      console.log(`\n  ${C.bold('comment')}\n${prep.comment.split('\n').map(l => `    ${l}`).join('\n')}`)
      for (const n of prep.notes) console.log(`  ${C.yellow('note')} ${n}`)
      if (prep.alreadyPublished) console.log(`  ${C.yellow('already posted')} ${prep.alreadyPublished.at} ${prep.alreadyPublished.comment}`)
      console.log(`\n  credentials: ${prep.credentials.ok ? C.green(prep.credentials.account) : C.red(`missing — ${prep.credentials.fix}`)}`)
      console.log(`  digest: ${prep.digest}   folder: ${C.dim(prep.folder)}`)
    }
    if (!has('yes')) { if (!asJson) console.log(`\n  ${C.dim('nothing sent. Re-run with --yes to post exactly this.')}\n`); else console.log(JSON.stringify(prep, null, 2)); break }
    const pub = await publishToLinear({ ticket, env, run: prep.run, digest: prep.digest, force: has('force') })
    if (asJson) { console.log(JSON.stringify(pub, null, 2)); process.exit(pub.ok ? 0 : 1) }
    if (!pub.ok) { console.log(`\n${C.red('not posted')}: ${pub.error}${pub.fix ? `\n  ${pub.fix}` : ''}\n`); process.exit(1) }
    console.log(`\n${C.green('posted')} ${pub.commentUrl}\n  ${pub.attachments.length} attachment(s)\n`)
    break
  }
  default:
    usage()
}
