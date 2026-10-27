// Spoken narration for DEMO runs (E2E_VOICE=1, macOS only). Each line is rendered
// to a WAV with the system `say` voice WHILE the test runs, so its length is known
// before the next step starts: the narrator holds the page until the line is done,
// and lines never overlap in the final video. Every line is recorded as a cue
// { at (ms from the start of the recording), file, ms, text } in voice.json next to
// video.webm; build_demo_video mixes the cues into the reel's audio track.
//
//   E2E_VOICE_NAME  a `say -v` voice (default Samantha; "Ava (Premium)" etc. once downloaded)
//   E2E_VOICE_RATE  words per minute (default 185)
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const VOICE_ON = process.env.E2E_VOICE === '1' && process.platform === 'darwin'
const VOICE = process.env.E2E_VOICE_NAME || 'Samantha'
const RATE = process.env.E2E_VOICE_RATE || '185'

export type Cue = { at: number, ms: number, file: string, text: string }

/** Length of a PCM WAV in ms, read from its fmt and data chunks. */
function wavMs (file: string): number {
  const b = fs.readFileSync(file)
  let byteRate = 0
  let off = 12
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'fmt ') byteRate = b.readUInt32LE(off + 16)
    if (id === 'data') return byteRate ? Math.round((Math.min(size, b.length - off - 8) / byteRate) * 1000) : 0
    off += 8 + size + (size % 2)
  }
  return 0
}

/** Renders one line to `file`. Returns its length in ms, or 0 when `say` failed. */
export function synth (text: string, file: string): number {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const r = spawnSync('say', ['-v', VOICE, '-r', RATE, '--file-format=WAVE', '--data-format=LEI16@22050', '-o', file, text], { timeout: 30_000 })
  if (r.status !== 0 || !fs.existsSync(file)) return 0
  return wavMs(file)
}

/** Turns a test or step title into something a voice reads naturally. */
export function speakable (text: string): string {
  return String(text ?? '')
    .replace(/^[A-Z][A-Z0-9]*-\d+\s+(?=TC-)/, '')            // "PLT-1234 TC-01 ..." -> "TC-01 ..."
    .replace(/\bTC-0*(\d+)\b/g, 'Test case $1.')
    .replace(/(^|\s)\/(?:[\w-]+\/)*([\w-]+)/g, (_m, pre, last) => `${pre}the ${last.replace(/-/g, ' ')} page`)
    .replace(/[“”"«»]/g, '')
    .replace(/\s*[·—–]\s*/g, ', ')
    .replace(/:\s/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, 'The ')
    .replace(/([.!?] )the /g, '$1The ')
}
