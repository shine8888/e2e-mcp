// Recordings: list what a run recorded, and stitch it into one demo reel.
// Source of truth is the run's own results.json -- the `video` attachment
// Playwright attaches per test (the harness sets video: 'on' for every browser project) -- never a directory scan, so the
// reel's order and PASS/FAIL marks are exactly what Playwright reported.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { FT_E2E_DIR, childPath, runInHarness } from '../ft-e2e.mjs'
import { DEFAULT_ENV, knownEnv } from '../env.mjs'
import { summarizeRun } from './summarize.mjs'
import { resolveRunDir } from './runs.mjs'
import { APP_REPOS, gitStamp } from './preflight.mjs'
import { checkToolkit } from './toolkit.mjs'
import {
  FRAME, renderCards, summaryCardHtml, testCardHtml, titleCardHtml,
} from './cards.mjs'

const SETUP_PROJECTS = new Set(['setup'])
// A recording at full frame width was made with DEMO=1, so it already opens on
// its own chapter card; an interstitial in front of it would repeat the title.
const DEMO_WIDTH = FRAME.width

// The stitched video is a test report, not a demo -- the file is named for that.
export const REEL_NAME = 'report.webm'

function evidenceDirFor (ticket, envName, run) {
  const env = knownEnv(envName)
  if (!env) throw new Error(`Unknown environment "${envName}".`)
  if (!env.evidenceDir) throw new Error(`Environment "${envName}" records no evidence (declared, not wired).`)
  // The newest run unless `run` names one; the reel is written into that run's folder.
  return { env, dir: resolveRunDir(env, ticket, run) ?? path.join(FT_E2E_DIR, 'tickets', ticket, env.evidenceDir, 'no-run') }
}

export function probe (file) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file,
    ], { env: { ...process.env, PATH: childPath() } }).toString()
    const j = JSON.parse(out)
    return {
      width: j.streams?.[0]?.width ?? null,
      height: j.streams?.[0]?.height ?? null,
      durationSec: j.format?.duration ? Number(Number(j.format.duration).toFixed(2)) : null,
    }
  } catch (err) {
    return { width: null, height: null, durationSec: null, error: err.message.split('\n')[0] }
  }
}

/** Every test in a run, in reporter order, with its video if one was recorded. */
export function runTests (resultsFile) {
  const data = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'))
  const tests = []
  const walk = (suite, trail) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (SETUP_PROJECTS.has(test.projectName)) continue
        const last = test.results?.[test.results.length - 1]
        const video = last?.attachments?.find(a => a.name === 'video' && a.path)?.path ?? null
        // A voiced demo run (E2E_VOICE=1) leaves voice.json: the spoken cues, timed to the recording.
        const voice = last?.attachments?.find(a => a.name === 'voice' && a.path)?.path ?? null
        const device = (test.annotations ?? []).find(a => a.type === 'device')?.description
          ?? (test.projectName?.startsWith('device-') ? test.projectName.slice(7) : null)
        tests.push({
          // A multi-device run repeats each case per screen; the screen is part of its name.
          title: device ? `${spec.title} — ${device}` : spec.title,
          device,
          file: [...trail].filter(Boolean)[0] ?? null,
          project: test.projectName,
          status: last?.status ?? 'skipped',
          durationMs: last?.duration ?? 0,
          video: video && fs.existsSync(video) ? video : null,
          voice: voice && fs.existsSync(voice) ? voice : null,
        })
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...trail, child.title])
  }
  for (const suite of data.suites ?? []) walk(suite, [suite.title])
  return tests
}

/**
 * What was actually under test, read from the run's own EVIDENCE.md (written by
 * the harness's build-report.mjs at run time). Falling back to the repo's CURRENT
 * branches would put today's checkout on a card about a run from days ago --
 * so when EVIDENCE.md is missing the stamp says so instead of guessing.
 */
function testedStamps (dir) {
  const md = path.join(dir, 'EVIDENCE.md')
  if (fs.existsSync(md)) {
    const rows = fs.readFileSync(md, 'utf-8').split('\n')
      .map(l => l.match(/^\| (Web|API) \| `([^`]+)` — (.+?) — /))
      .filter(Boolean)
      .map(m => `${m[2]}: ${m[3]}`)
    if (rows.length) return rows
  }
  return APP_REPOS.map(r => `${gitStamp(r)} (current checkout -- no EVIDENCE.md recorded the tested commit)`)
}

/** Headline for the tests the reel shows; the setup project is not one of them. */
function reelHeadline (tests) {
  const passed = tests.filter(t => t.status === 'passed').length
  const failed = tests.filter(t => !['passed', 'skipped'].includes(t.status)).length
  const skipped = tests.filter(t => t.status === 'skipped').length
  const parts = [`${passed} of ${tests.length} passed`]
  if (failed) parts.push(`${failed} failed`)
  if (skipped) parts.push(`${skipped} skipped`)
  return parts.join(' · ')
}

/** @param {{ ticket: string, env?: string, run?: string }} opts */
export function listVideos ({ ticket, env: envName = DEFAULT_ENV, run }) {
  const { env, dir } = evidenceDirFor(ticket, envName, run)
  const resultsFile = path.join(dir, 'results.json')
  if (!fs.existsSync(resultsFile)) return { ok: false, error: `No run recorded for ${ticket} on ${env.name}.` }
  const tests = runTests(resultsFile).map(t => ({
    ...t,
    ...(t.video ? probe(t.video) : {}),
    demoRecorded: t.video ? probe(t.video).width >= DEMO_WIDTH : false,
  }))
  // report.webm is the reel's name; demo.webm is still read if one was copied in.
  const reel = [REEL_NAME, 'demo.webm'].map(f => path.join(dir, f)).find(f => fs.existsSync(f)) ?? path.join(dir, REEL_NAME)
  return {
    ok: true,
    ticket,
    env: env.name,
    run: path.basename(dir),
    tests,
    withVideo: tests.filter(t => t.video).length,
    withoutVideo: tests.filter(t => !t.video).length,
    demoReel: fs.existsSync(reel) ? { path: reel, ...probe(reel) } : null,
  }
}

function ffmpeg (args, timeoutMs) {
  return new Promise((resolve) => {
    // childPath(): Homebrew's ffmpeg is not on PATH when Claude Code starts the
    // server without a login shell (2026-10-13: "spawn ffmpeg ENOENT" crashed the process).
    const child = spawn('ffmpeg', args, { env: { ...process.env, PATH: childPath() } })
    let stderr = ''
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stderr: `${err.message} -- is ffmpeg installed (brew install ffmpeg)?` }) })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-6000) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }) })
  })
}

// --- Voice -------------------------------------------------------------------
// Voiced runs carry voice.json per test: { cues: [{ at, ms, file, text }] }, `at` in
// ms from the start of that test's recording. The cards get their own lines here,
// in the same voice the harness used (E2E_VOICE_NAME / E2E_VOICE_RATE).
const VOICE = process.env.E2E_VOICE_NAME || 'Samantha'
const RATE = process.env.E2E_VOICE_RATE || '185'
const AUDIO = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono'

/** Renders one card line with `say`. Returns { file, sec } or null (no `say`, not macOS). */
function sayToFile (text, file) {
  if (process.platform !== 'darwin') return null
  try {
    execFileSync('say', ['-v', VOICE, '-r', RATE, '--file-format=WAVE', '--data-format=LEI16@22050', '-o', file, text], { timeout: 30_000 })
  } catch { return null }
  const sec = probeAudioSec(file)
  return sec ? { file, sec } : null
}

function probeAudioSec (file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { env: { ...process.env, PATH: childPath() } }).toString().trim()
    return Number(out) || 0
  } catch { return 0 }
}

/** One test's spoken cues mixed onto a silent track exactly as long as its recording. */
async function mixTestVoice (voiceJson, durationSec, outFile, timeoutMs) {
  const { cues = [] } = JSON.parse(fs.readFileSync(voiceJson, 'utf-8'))
  const usable = cues.filter(c => c.file && fs.existsSync(c.file) && c.at / 1000 < durationSec)
  if (!usable.length) return null
  const args = ['-y', '-v', 'error']
  for (const c of usable) args.push('-i', c.file)
  const delayed = usable.map((c, i) => `[${i}:a]${AUDIO},adelay=${Math.max(0, Math.round(c.at))}:all=1[c${i}]`)
  const mix = `${usable.map((_, i) => `[c${i}]`).join('')}amix=inputs=${usable.length}:normalize=0:dropout_transition=0,apad,atrim=0:${durationSec}[a]`
  args.push('-filter_complex', [...delayed, mix].join(';'), '-map', '[a]', '-c:a', 'pcm_s16le', outFile)
  const res = await ffmpeg(args, timeoutMs)
  return res.code === 0 && fs.existsSync(outFile) ? { cues: usable.length } : null
}

/**
 * Stitches a run into `<run dir>/report.webm`:
 *   title card -> [per-test card] -> recording ... -> summary card
 * with a WebM chapter per segment so a player can jump between tests.
 *
 * Voiced runs (voice.json per test) also get a spoken audio track; voice:false drops it.
 *
 * @param {{ ticket: string, env?: string, interstitials?: 'auto'|'always'|'never', voice?: boolean,
 *           titleSec?: number, cardSec?: number, summarySec?: number, timeoutMs?: number }} opts
 */
export async function buildDemoVideo ({
  ticket, env: envName = DEFAULT_ENV, run, interstitials = 'auto', voice,
  titleSec = 3.5, cardSec = 2.5, summarySec = 5, timeoutMs = 20 * 60_000,
}) {
  const { env, dir } = evidenceDirFor(ticket, envName, run)
  const resultsFile = path.join(dir, 'results.json')
  if (!fs.existsSync(resultsFile)) return { ok: false, error: `No run recorded for ${ticket} on ${env.name}.` }

  const tests = runTests(resultsFile)
  const recorded = tests.filter(t => t.video)
  if (!recorded.length) {
    return {
      ok: false,
      error: `The ${ticket} run on ${env.name} has no recorded videos. API-only runs (apiOnly) open no `
        + 'browser and record none -- re-run the browser specs (run_e2e with demo: true for a narrated one).',
      tests: tests.map(t => ({ title: t.title, status: t.status })),
    }
  }

  const tk = await checkToolkit({ features: ['demo'] })
  const vidMissing = tk.missing.filter(m => ['ffmpeg', 'ffmpeg-libvpx', 'ffprobe'].includes(m.id))
  if (vidMissing.length) {
    return { ok: false, stage: 'toolkit', error: `Cannot encode the reel: missing ${vidMissing.map(m => m.label).join(', ')}.`, missing: vidMissing.map(m => ({ id: m.id, kind: m.kind, command: m.command })) }
  }

  const summary = summarizeRun(resultsFile)
  const work = path.join(dir, '.video-build')
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })

  // Spoken reel: only when the run was recorded with voice and voice is not turned off here.
  const voiced = voice !== false && recorded.some(t => t.voice)
  const cardLine = (name, text, minSec) => {
    if (!voiced) return { sec: minSec, audio: null }
    const said = sayToFile(text, path.join(work, `${name}.wav`))
    return said ? { sec: Math.max(minSec, said.sec + 0.8), audio: said.file } : { sec: minSec, audio: null }
  }

  try {
    const cards = [{
      name: '00-title',
      html: titleCardHtml({
        ticket,
        envLabel: env.label,
        startedAt: summary.startTime ? new Date(summary.startTime).toLocaleString() : 'unknown',
        testCount: recorded.length,
        stamps: testedStamps(dir),
      }),
    }]
    const titleLine = cardLine('00-title', `${ticket} on ${env.label}. End-to-end test report. ${recorded.length} test${recorded.length === 1 ? '' : 's'}.`, titleSec)
    const segments = [{ kind: 'card', name: '00-title', sec: titleLine.sec, audio: titleLine.audio, chapter: `${ticket} · ${env.label}` }]

    recorded.forEach((t, i) => {
      const info = probe(t.video)
      // A device run always gets the card: it is what names the screen
      // before a phone-sized recording that is otherwise easy to misread.
      const wantsCard = interstitials === 'always'
        || (interstitials === 'auto' && (!(info.width >= DEMO_WIDTH) || !!t.device))
      if (wantsCard) {
        const name = `${String(i + 1).padStart(2, '0')}-test`
        cards.push({
          name,
          html: testCardHtml({
            index: i + 1, total: recorded.length, title: t.title, status: t.status, durationMs: t.durationMs,
          }),
        })
        const line = cardLine(name, `Test ${i + 1} of ${recorded.length}. ${t.title.replace(/^[A-Z][A-Z0-9]*-\d+\s+/, '')}.`, cardSec)
        segments.push({ kind: 'card', name, sec: line.sec, audio: line.audio, chapter: null })
      }
      segments.push({
        kind: 'video', file: t.video, voice: t.voice, sec: info.durationSec ?? 0, chapter: `Test ${i + 1}: ${t.title} — ${t.status.toUpperCase()}`,
      })
    })

    cards.push({
      name: '99-summary',
      html: summaryCardHtml({ ticket, envLabel: env.label, headline: reelHeadline(recorded), tests: recorded }),
    })
    const failedTitles = recorded.filter(t => !['passed', 'skipped'].includes(t.status)).map(t => t.title.replace(/^[A-Z][A-Z0-9]*-\d+\s+/, ''))
    const summaryLine = cardLine('99-summary', `Result. ${reelHeadline(recorded).replace(/ · /g, ', ')}.${failedTitles.length ? ` Failed: ${failedTitles.join('; ')}.` : ''}`, summarySec)
    segments.push({ kind: 'card', name: '99-summary', sec: summaryLine.sec, audio: summaryLine.audio, chapter: 'Result' })

    // Each recording's own spoken track, the same length as the recording.
    let voicedTests = 0
    if (voiced) {
      for (const [i, seg] of segments.entries()) {
        if (seg.kind !== 'video' || !seg.voice || !seg.sec) continue
        const out = path.join(work, `voice-${String(i).padStart(2, '0')}.wav`)
        if (await mixTestVoice(seg.voice, seg.sec, out, timeoutMs)) { seg.audio = out; voicedTests++ }
      }
    }

    const pngs = await renderCards(cards, work)
    const pngFor = name => pngs.find(p => path.basename(p) === `${name}.png`)

    // Chapters: a card with chapter:null (an interstitial) is folded into the
    // chapter of the test that follows it, so each test is one jump target.
    const meta = [';FFMETADATA1', `title=${ticket} · ${env.label} test run`]
    let t0 = 0
    let pendingStart = null
    for (const seg of segments) {
      const start = pendingStart ?? t0
      const end = t0 + seg.sec
      if (seg.chapter === null) {
        pendingStart = start
      } else {
        meta.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(start * 1000)}`,
          `END=${Math.round(end * 1000)}`, `title=${seg.chapter.replace(/[=;#\\\n]/g, ' ')}`)
        pendingStart = null
      }
      t0 = end
    }
    const metaFile = path.join(work, 'chapters.txt')
    fs.writeFileSync(metaFile, `${meta.join('\n')}\n`)

    const args = ['-y', '-v', 'error']
    for (const seg of segments) {
      if (seg.kind === 'card') args.push('-loop', '1', '-framerate', '25', '-t', String(seg.sec), '-i', pngFor(seg.name))
      else args.push('-i', seg.file)
    }
    // Voiced: one audio input per segment after the video inputs -- its spoken
    // line or track, else silence -- so concat can join picture and sound together.
    const audioIndex = []
    if (voiced) {
      for (const seg of segments) {
        audioIndex.push(segments.length + audioIndex.length)
        if (seg.audio) args.push('-i', seg.audio)
        else args.push('-f', 'lavfi', '-t', String(seg.sec), '-i', 'anullsrc=r=48000:cl=mono')
      }
    }
    args.push('-i', metaFile)
    const metaIndex = segments.length + audioIndex.length
    const norm = segments.map((_, i) => `[${i}:v]scale=${FRAME.width}:${FRAME.height}:force_original_aspect_ratio=decrease,`
      + `pad=${FRAME.width}:${FRAME.height}:(ow-iw)/2:(oh-ih)/2:color=0x0f172a,fps=25,format=yuv420p,setsar=1[v${i}]`)
    const anorm = voiced
      ? segments.map((seg, i) => `[${audioIndex[i]}:a]${AUDIO},apad,atrim=0:${seg.sec},asetpts=N/SR/TB[a${i}]`)
      : []
    const concat = voiced
      ? `${segments.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segments.length}:v=1:a=1[out][aout]`
      : `${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[out]`

    const outFile = path.join(dir, REEL_NAME)
    const tmpOut = path.join(work, REEL_NAME)
    args.push('-filter_complex', [...norm, ...anorm, concat].join(';'), '-map', '[out]',
      ...(voiced ? ['-map', '[aout]'] : []),
      '-map_metadata', String(metaIndex), '-map_chapters', String(metaIndex),
      '-c:v', 'libvpx', '-b:v', '4M', '-crf', '10', '-deadline', 'good', '-cpu-used', '4',
      ...(voiced ? ['-c:a', 'libopus', '-b:a', '96k'] : ['-an']), tmpOut)

    const started = Date.now()
    const res = await ffmpeg(args, timeoutMs)
    if (res.code !== 0 || !fs.existsSync(tmpOut)) {
      return { ok: false, error: `ffmpeg exited ${res.code}`, detail: res.stderr.slice(-1500) }
    }
    fs.renameSync(tmpOut, outFile)
    // RUNS.md (the run history the harness's build-report.mjs keeps) was written
    // before this reel existed; rebuild it so the run's row links report.webm.
    if (path.basename(path.dirname(dir)) === 'runs') {
      await runInHarness('node', ['scripts/build-report.mjs', ticket, env.harnessEnv, path.basename(dir)], { timeoutMs: 60_000 })
    }

    return {
      ok: true,
      ticket,
      env: env.name,
      run: path.basename(dir),
      path: outFile,
      ...probe(outFile),
      sizeMb: Number((fs.statSync(outFile).size / 1_048_576).toFixed(1)),
      encodeSec: Number(((Date.now() - started) / 1000).toFixed(1)),
      testsIncluded: recorded.length,
      voice: voiced ? { tests: voicedTests, cards: segments.filter(s => s.kind === 'card' && s.audio).length } : null,
      testsWithoutVideo: tests.filter(t => !t.video).map(t => t.title),
      chapters: segments.filter(s => s.chapter).map(s => s.chapter),
      openCommand: `open "${outFile}"`,
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
