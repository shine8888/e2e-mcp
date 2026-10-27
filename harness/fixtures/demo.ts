// Demo narration (DEMO=1). Drawn into the page itself so it is burned into the
// recording, with one colour system: blue = an action, green = a verified
// result, red = a failure.
//
//   - a chapter card per test (title, ticket, environment, screen)
//   - a lower-third "Step N" caption per top-level test.step, which turns
//     green only once that step's checks have passed (red if it throws)
//   - a STEPS checklist (hidden under 900px wide, where the caption goes compact)
//   - a ring + arrow + plain-English label on every click / type / tick / select,
//     measured after scrolling; password values are never shown
//   - demo.circle / demo.point / demo.callout for results no action touches
//   - a step recap at the end
//   - with E2E_VOICE=1 (voice.ts), each chapter, step, result note and recap is
//     also read aloud; the page waits for each line, so lines never overlap
//
// Everything is pointer-events:none and re-drawn after a full navigation.
import fs from 'node:fs'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { type Cue, VOICE_ON, speakable, synth } from './voice'

type StepRow = { n: number, title: string, status: 'run' | 'ok' | 'fail' }
type Mark = { x: number, y: number, w: number, h: number, label: string, tone: 'action' | 'ok' | 'fail', arrow: boolean }

export const COLORS = { action: '#2563eb', ok: '#16a34a', fail: '#dc2626' }

/* Runs in the page. Re-creates the whole overlay from `s` every call. */
function drawOverlay (s: any) {
  const ID = '__rs_demo'
  let root = document.getElementById(ID)
  if (!root) {
    root = document.createElement('div')
    root.id = ID
    root.setAttribute('aria-hidden', 'true')
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
    ;(document.body || document.documentElement).appendChild(root)
  }
  const C = { action: '#2563eb', ok: '#16a34a', fail: '#dc2626' }
  const esc = (t: string) => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c])
  const vw = window.innerWidth
  const vh = window.innerHeight
  const compact = vw < 900
  const k = compact ? Math.max(0.62, vw / 900) : 1
  let html = ''

  if (s.chapter) {
    html += `<div style="position:absolute;inset:0;background:rgba(15,23,42,.94);display:flex;flex-direction:column;justify-content:center;padding:0 ${compact ? 24 : 120}px;color:#e2e8f0">
      <div style="color:#fbbf24;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:${Math.round(20 * k)}px">${esc(s.chapter.eyebrow)}</div>
      <div style="color:#fff;font-weight:750;line-height:1.15;margin:14px 0 18px;font-size:${Math.round(48 * k)}px">${esc(s.chapter.title)}</div>
      <div style="color:#94a3b8;font-size:${Math.round(20 * k)}px">${esc(s.chapter.meta)}</div></div>`
  }
  if (s.recap) {
    html += `<div style="position:absolute;inset:0;background:rgba(15,23,42,.94);display:flex;flex-direction:column;justify-content:center;padding:0 ${compact ? 24 : 120}px;color:#e2e8f0">
      <div style="color:#fbbf24;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:${Math.round(20 * k)}px">Recap</div>
      <div style="color:#fff;font-weight:750;margin:12px 0 18px;font-size:${Math.round(40 * k)}px">${esc(s.recap.title)}</div>
      ${(s.steps || []).map((r: any) => `<div style="font-size:${Math.round(22 * k)}px;line-height:1.7;color:${r.status === 'fail' ? '#fca5a5' : r.status === 'ok' ? '#86efac' : '#cbd5e1'}">${r.status === 'ok' ? '✓' : r.status === 'fail' ? '✗' : '•'} Step ${r.n} · ${esc(r.title)}</div>`).join('')}
    </div>`
  }
  if (!s.chapter && !s.recap && !compact && (s.steps || []).length) {
    html += `<div style="position:absolute;top:16px;right:16px;max-width:340px;background:rgba(15,23,42,.86);color:#e2e8f0;border-radius:10px;padding:12px 16px;font-size:13px;line-height:1.6">
      <div style="font-weight:700;letter-spacing:.08em;color:#94a3b8;font-size:11px;margin-bottom:4px">STEPS</div>
      ${s.steps.map((r: any) => `<div style="color:${r.status === 'fail' ? '#fca5a5' : r.status === 'ok' ? '#86efac' : '#fff'}">${r.status === 'ok' ? '✓' : r.status === 'fail' ? '✗' : '›'} ${r.n}. ${esc(r.title)}</div>`).join('')}
    </div>`
  }
  if (!s.chapter && !s.recap && s.caption) {
    const tone = s.caption.status === 'ok' ? C.ok : s.caption.status === 'fail' ? C.fail : C.action
    const icon = s.caption.status === 'ok' ? '✓ ' : s.caption.status === 'fail' ? '✗ ' : ''
    html += `<div style="position:absolute;left:${compact ? 8 : 24}px;bottom:${compact ? 8 : 24}px;max-width:${compact ? vw - 16 : Math.min(900, vw - 48)}px;background:rgba(15,23,42,.9);color:#fff;border-left:${Math.round(6 * k)}px solid ${tone};border-radius:8px;padding:${Math.round(12 * k)}px ${Math.round(18 * k)}px;box-shadow:0 6px 24px rgba(0,0,0,.25)">
      <div style="font-size:${Math.round(13 * k)}px;font-weight:700;letter-spacing:.08em;color:${tone}">${icon}STEP ${s.caption.n}</div>
      <div style="font-size:${Math.round(22 * k)}px;font-weight:650;line-height:1.25">${esc(s.caption.title)}</div></div>`
  }
  if (s.toast) {
    html += `<div style="position:absolute;top:${compact ? 8 : 16}px;left:50%;transform:translateX(-50%);max-width:${vw - 32}px;background:${C.ok};color:#fff;border-radius:999px;padding:${Math.round(8 * k)}px ${Math.round(20 * k)}px;font-size:${Math.round(17 * k)}px;font-weight:650;box-shadow:0 6px 24px rgba(0,0,0,.25)">✓ ${esc(s.toast)}</div>`
  }
  for (const m of (s.marks || [])) {
    const col = (C as any)[m.tone] || C.action
    const pad = 6
    const x = m.x - pad; const y = m.y - pad; const w = m.w + pad * 2; const h = m.h + pad * 2
    html += `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border:3px solid ${col};border-radius:10px;box-shadow:0 0 0 4px ${col}33"></div>`
    if (m.label) {
      const below = y + h + 44 < vh
      const ly = below ? y + h + 10 : Math.max(4, y - 40)
      const lx = Math.min(Math.max(4, x), Math.max(4, vw - 360))
      html += `<div style="position:absolute;left:${lx}px;top:${ly}px;max-width:${Math.min(360, vw - 8)}px;background:${col};color:#fff;border-radius:6px;padding:4px 10px;font-size:${Math.round(15 * k)}px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m.arrow ? (below ? '▲ ' : '▼ ') : ''}${esc(m.label)}</div>`
    }
  }
  root.innerHTML = html
}

export class Narrator {
  steps: StepRow[] = []
  caption: StepRow | null = null
  marks: Mark[] = []
  toast: string | null = null
  chapterInfo: { eyebrow: string, title: string, meta: string } | null = null
  recapOn = false
  depth = 0
  cues: Cue[] = []
  /* The recording starts with the page; cue times are measured from here. */
  private t0 = Date.now()
  private busyUntil = 0
  private onLoad = () => { this.render().catch(() => {}) }

  constructor (public page: Page, public testInfo: TestInfo, private meta: Record<string, any>) {
    page.on('load', this.onLoad)
  }

  /**
   * Reads `text` aloud in the final video (E2E_VOICE=1). Waits for the previous line
   * to finish first, then lets the test carry on while this one plays; `hold` also
   * waits for this one. Returns the line's length in ms (0 when voice is off).
   */
  async say (text: string, { hold = false } = {}): Promise<number> {
    if (!VOICE_ON || !text || this.page.isClosed()) return 0
    const wait = this.busyUntil - Date.now()
    if (wait > 0) await this.page.waitForTimeout(wait).catch(() => {})
    const line = speakable(text)
    const file = this.testInfo.outputPath(`voice-${String(this.cues.length + 1).padStart(2, '0')}.wav`)
    const ms = synth(line, file)
    if (!ms) return 0
    this.cues.push({ at: Date.now() - this.t0, ms, file, text: line })
    this.busyUntil = Date.now() + ms + 250
    if (hold) await this.page.waitForTimeout(ms + 250).catch(() => {})
    return ms
  }

  /** Writes voice.json next to the recording and attaches it for build_demo_video. */
  async saveVoice () {
    if (!this.cues.length) return
    const wait = this.busyUntil - Date.now()
    if (wait > 0 && !this.page.isClosed()) await this.page.waitForTimeout(wait).catch(() => {})
    const file = this.testInfo.outputPath('voice.json')
    fs.writeFileSync(file, JSON.stringify({ cues: this.cues }, null, 2))
    await this.testInfo.attach('voice', { path: file, contentType: 'application/json' })
  }

  async render () {
    if (this.page.isClosed()) return
    await this.page.evaluate(drawOverlay, {
      steps: this.steps, caption: this.caption, marks: this.marks, toast: this.toast,
      chapter: this.chapterInfo, recap: this.recapOn ? { title: this.testInfo.title } : null,
    }).catch(() => {})
  }

  async chapter () {
    const ticket = process.env.E2E_TICKET || 'adhoc'
    this.chapterInfo = {
      eyebrow: `${ticket} · ${process.env.ENV || 'local'}`,
      title: this.testInfo.title,
      meta: [this.meta.deviceLabel, this.meta.browserLabel].filter(Boolean).join(' · '),
    }
    await this.render()
    const spoke = await this.say(this.testInfo.title, { hold: true })
    if (!spoke) await this.page.waitForTimeout(2200)
    this.chapterInfo = null
    await this.render()
  }

  async recap () {
    if (!this.steps.length) return
    this.recapOn = true
    this.marks = []
    await this.render()
    const failed = this.steps.find(r => r.status === 'fail')
    const ok = this.steps.filter(r => r.status === 'ok').length
    const spoke = await this.say(failed
      ? `Failed at step ${failed.n}, ${failed.title}.`
      : `Passed. ${ok} of ${this.steps.length} steps passed.`, { hold: true })
    if (!spoke) await this.page.waitForTimeout(2500)
  }

  async step<T> (title: string, run: () => Promise<T>): Promise<T> {
    const row: StepRow = { n: this.steps.length + 1, title, status: 'run' }
    this.steps.push(row)
    this.caption = row
    await this.render()
    await this.say(`Step ${row.n}. ${title}.`)
    await this.page.waitForTimeout(500)
    try {
      const out = await run()
      row.status = 'ok'
      await this.render()
      await this.page.waitForTimeout(700)
      return out
    } catch (err) {
      row.status = 'fail'
      await this.render()
      await this.say(`Step ${row.n} failed.`, { hold: true })
      await this.page.waitForTimeout(900).catch(() => {})
      throw err
    }
  }

  async mark (locator: Locator, label: string, tone: Mark['tone'], arrow: boolean, holdMs: number) {
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 4000 })
      const box = await locator.boundingBox({ timeout: 2000 })
      if (!box) return
      const m: Mark = { ...{ x: box.x, y: box.y, w: box.width, h: box.height }, label, tone, arrow }
      this.marks = [m]
      await this.render()
      await this.page.waitForTimeout(holdMs)
    } catch { /* never let narration fail a test */ }
  }

  async clearMarks () {
    this.marks = []
    await this.render()
  }

  async callout (text: string) {
    this.toast = text
    await this.render()
    const spoke = await this.say(text, { hold: true })
    if (!spoke) await this.page.waitForTimeout(1600)
    this.toast = null
    await this.render()
  }
}

// ---------------------------------------------------------------------------
// The active narrator for the running test (one worker runs one test at a time).
export const active: { narrator: Narrator | null } = { narrator: null }

const VERB: Record<string, string> = {
  click: 'Click', dblclick: 'Double-click', tap: 'Tap', fill: 'Type', pressSequentially: 'Type',
  check: 'Tick', uncheck: 'Untick', setChecked: 'Set', selectOption: 'Select', press: 'Press',
}

async function describe (loc: Locator, method: string, args: any[]): Promise<string> {
  const name = await loc.evaluate((el: any) => {
    const t = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('name') || el.tagName).toString()
    return { text: t.replace(/\s+/g, ' ').trim().slice(0, 48), secret: el.type === 'password' || /card|cvv|cvc|security code|expir/i.test(el.getAttribute('aria-label') || '') }
  }, undefined, { timeout: 1500 }).catch(() => ({ text: '', secret: false }))
  const verb = VERB[method] ?? method
  if (method === 'fill' || method === 'pressSequentially') {
    const v = name.secret ? '••••••' : String(args[0] ?? '').slice(0, 32)
    return `${verb} “${v}” into ${name.text || 'the field'}`
  }
  if (method === 'selectOption') return `${verb} “${typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0])}”`
  if (method === 'press') return `${verb} ${args[0]}`
  return `${verb} “${name.text}”`
}

let patched = false
/** Wraps Locator actions once per worker so every action is announced while a narrator is active. */
export function patchLocator (sample: Locator) {
  if (patched) return
  patched = true
  const proto = Object.getPrototypeOf(sample)
  for (const method of Object.keys(VERB)) {
    const orig = proto[method]
    if (typeof orig !== 'function') continue
    proto[method] = async function (this: Locator, ...args: any[]) {
      const n = active.narrator
      if (n && !n.page.isClosed()) {
        const label = await describe(this, method, args)
        await n.mark(this, label, 'action', true, 650)
      }
      try {
        return await orig.apply(this, args)
      } finally {
        if (n && active.narrator === n) await n.clearMarks().catch(() => {})
      }
    }
  }
}

/** Spec-facing helpers; no-ops when the run is not narrated. */
export function demoApi () {
  return {
    enabled: () => !!active.narrator,
    circle: async (loc: Locator, label = '') => { await active.narrator?.mark(loc, label, 'ok', false, 1400); await active.narrator?.clearMarks() },
    point: async (loc: Locator, label = '') => { await active.narrator?.mark(loc, label, 'ok', true, 1400); await active.narrator?.clearMarks() },
    callout: async (text: string) => { await active.narrator?.callout(text) },
  }
}
