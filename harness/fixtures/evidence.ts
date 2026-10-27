// Evidence figures and the layout audit.
//
// evidence.snap(title, { boxes, mark, note }) attaches two PNGs to the test:
//   "<title> · raw"  the clean FULL-PAGE screenshot (no demo overlay), at device pixel ratio
//   "<title>"        a figure sized to its content: header, the screenshot at a readable size
//                    with rings around what was checked (green = correct, red = wrong,
//                    amber = warning, blue = marked), inline labels, a legend and a note
// A full-page capture on purpose: a viewport-only shot hides most of a long page, so the
// figure would not show what the test actually checked.
//
// In a device run every snap -- and the end of every case -- is also audited:
//   break    the page scrolls sideways (content wider than the layout viewport)
//   clipped  content is cut off by a container that hides overflow and cannot be scrolled (a wide table in a
//            card with overflow:hidden), so it cannot be seen or reached; also a full-width page pane that
//            scrolls sideways inside itself counts as a break
//   warning  touch targets under 24x24px (WCAG 2.2 AA 2.5.8) on touch screens, and text under
//            12px on phones
// Content inside its own horizontal scroller does not count. Only selectors, sizes and
// positions are recorded, never page text. Every finding carries its box in page
// coordinates, so the report can crop to it and circle it.
import fs from 'node:fs'
import type { Locator, Page, TestInfo } from '@playwright/test'

export type Box = { x: number, y: number, w: number, h: number }
export type Tone = 'ok' | 'bad' | 'warn' | 'info'
export type AnnBox = Box & { label?: string, tone?: Tone }

export type LayoutCheck = {
  at: string
  viewport: number
  scrollWidth: number
  scrollHeight: number
  dpr: number
  shot: string | null // the raw full-page screenshot this audit was taken with (absolute path)
  break: boolean
  offenders: { selector: string, width: number, right: number, interactive: boolean, box: Box, pane?: { selector: string, contentW: number, visibleW: number } }[]
  clipped: { selector: string, names: string, count: number, partial: boolean, contentW: number, visibleW: number, hiddenPx: number, box: Box }[]
  smallTargets: { selector: string, width: number, height: number, box: Box }[]
  smallText: { count: number, samples: { selector: string, box: Box }[] }
}

/* Runs in the page. */
function audit ({ touch, phone }: { touch: boolean, phone: boolean }) {
  const de = document.documentElement
  const vw = de.clientWidth
  const sx = window.scrollX
  const sy = window.scrollY
  const docBox = (r: DOMRect) => ({ x: Math.round(r.x + sx), y: Math.round(r.y + sy), w: Math.round(r.width), h: Math.round(r.height) })
  const sel = (el: Element) => {
    const one = (e: Element) => {
      let s = e.tagName.toLowerCase()
      const id = (e as HTMLElement).id
      // ids with digits are generated per render (rs-combobox-4665-2200): they would make every screen a different finding
      if (id && !/\d/.test(id)) s += `#${id}`
      const cls = [...e.classList].filter(c => !/^(is-|has-|--)/.test(c) && !/\d{3,}/.test(c)).slice(0, 2)
      if (cls.length) s += `.${cls.join('.')}`
      return s
    }
    const p = el.parentElement
    return p && p !== document.body && p !== de ? `${one(p)} > ${one(el)}` : one(el)
  }
  const visible = (el: Element) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0
  }
  const clipsX = (el: Element) => ['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(el).overflowX)
  const insideScroller = (el: Element) => {
    for (let a = el.parentElement; a && a !== document.body && a !== de; a = a.parentElement) if (clipsX(a)) return true
    return false
  }
  const pageClips = ['hidden', 'clip'].includes(getComputedStyle(de).overflowX) || ['hidden', 'clip'].includes(getComputedStyle(document.body).overflowX)
  const isBreak = !pageClips && de.scrollWidth > vw + 1
  const interactiveSel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=tab]'
  const all = [...document.body.querySelectorAll('*')].filter(el => !el.closest('#__rs_demo'))

  const offenders: any[] = []
  const outermostBeyond = (root: Element, limit: number, stopAt?: Element) => {
    const hits: Element[] = []
    for (const el of root.querySelectorAll('*')) {
      if (el.closest('#__rs_demo') || el instanceof SVGElement) continue
      const r = el.getBoundingClientRect()
      if (r.right > limit + 1 && r.width > 0 && visible(el) && !hits.some(h => h.contains(el))) {
        // skip anything that sits inside a nested scroller (it is reachable by scrolling that scroller)
        let nested = false
        for (let a = el.parentElement; a && a !== root && a !== stopAt; a = a.parentElement) { if (clipsX(a)) { nested = true; break } }
        if (!nested) hits.push(el)
      }
      if (hits.length >= 8) break
    }
    return hits
  }
  if (isBreak) {
    for (const el of outermostBeyond(document.body, vw)) {
      const r = el.getBoundingClientRect()
      offenders.push({ selector: sel(el), width: Math.round(r.width), right: Math.round(r.right + sx), interactive: el.matches(interactiveSel), box: docBox(r) })
    }
  } else {
    // The document does not scroll sideways, but the page's own content pane may (a full-width
    // overflow-x:auto container): the user still has to scroll the page content sideways.
    for (const pane of all) {
      const cs = getComputedStyle(pane)
      if (!['auto', 'scroll'].includes(cs.overflowX) || pane === document.body) continue
      const pr = pane.getBoundingClientRect()
      if (pr.width < vw * 0.9 || pane.scrollWidth <= pane.clientWidth + 2 || pr.left > 4) continue
      const culprits = outermostBeyond(pane, pr.right, pane).slice(0, 6)
      for (const el of culprits) {
        const r = el.getBoundingClientRect()
        offenders.push({ selector: sel(el), width: Math.round(r.width), right: Math.round(r.right + sx), interactive: el.matches(interactiveSel), box: docBox(r), pane: { selector: sel(pane), contentW: pane.scrollWidth, visibleW: pane.clientWidth } })
      }
    }
  }

  // Content cut off by a container that hides its overflow and cannot be scrolled: a wide table in
  // a card with overflow:hidden, a toolbar in a clipped row. Grouped per container, so one wide
  // table is ONE finding however many columns it hides.
  const clippers = new Map<Element, { leaves: { r: DOMRect, name: string }[], partial: boolean }>()
  for (const leaf of document.body.querySelectorAll('*')) {
    if (leaf.children.length || leaf instanceof SVGElement || leaf.closest('#__rs_demo') || !(leaf.textContent ?? '').trim() || !visible(leaf)) continue
    const r = leaf.getBoundingClientRect()
    for (let a = leaf.parentElement; a && a !== document.body && a !== de; a = a.parentElement) {
      const acs = getComputedStyle(a)
      const o = acs.overflowX
      if (o === 'auto' || o === 'scroll') break // reachable by scrolling it
      if (o !== 'hidden' && o !== 'clip') continue
      const ar = a.getBoundingClientRect()
      if (ar.width === 0 || ar.left >= vw || ar.right <= 0) break // the container is off-screen (a closed drawer): intended
      if (acs.textOverflow === 'ellipsis' || getComputedStyle(leaf).textOverflow === 'ellipsis') break // truncated text on purpose
      const hidden = Math.min(r.width, Math.max(0, r.right - ar.right) + Math.max(0, ar.left - r.left))
      if (hidden > 2) {
        const entry = clippers.get(a) ?? { leaves: [], partial: false }
        // Only UI labels are kept (headings / buttons / links), never cell data.
        const labelEl = leaf.closest('th,button,a,[role=button],label')
        entry.leaves.push({ r, name: labelEl ? ((labelEl as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '' })
        if (hidden < r.width - 2) entry.partial = true
        clippers.set(a, entry)
        break
      }
    }
  }
  const clipped: any[] = []
  for (const [a, e] of clippers) {
    const ar = a.getBoundingClientRect()
    const contentW = Math.round(Math.max(...e.leaves.map(l => l.r.right)) - ar.left)
    const names = [...new Set(e.leaves.map(l => l.name).filter(Boolean))].slice(0, 5).join(', ')
    clipped.push({ selector: sel(a), names, count: e.leaves.length, partial: e.partial, contentW, visibleW: Math.round(ar.width), hiddenPx: Math.max(0, contentW - Math.round(ar.width)), box: docBox(ar) })
    if (clipped.length >= 8) break
  }

  const smallTargets: any[] = []
  if (touch) {
    for (const el of document.body.querySelectorAll(interactiveSel)) {
      if (el.closest('#__rs_demo') || !visible(el)) continue
      const cs = getComputedStyle(el)
      if (el.tagName === 'A' && cs.display === 'inline') continue // inline link in a sentence: WCAG exception
      const r = el.getBoundingClientRect()
      // A 2px sliver is the hidden search input inside a combobox (the visible control is its wrapper); an
      // element wholly outside the screen is in a closed drawer. Neither is something a user can tap.
      if (r.width <= 3 || r.right <= 0 || r.left >= vw) continue
      if (r.width < 24 || r.height < 24) smallTargets.push({ selector: sel(el), width: Math.round(r.width), height: Math.round(r.height), box: docBox(r) })
      if (smallTargets.length >= 20) break
    }
  }
  const smallText = { count: 0, samples: [] as any[] }
  if (phone) {
    for (const el of all) {
      const own = [...el.childNodes].some(n => n.nodeType === 3 && (n.textContent ?? '').trim())
      if (!own || !visible(el)) continue
      if (parseFloat(getComputedStyle(el).fontSize) < 12) {
        smallText.count++
        if (smallText.samples.length < 8) smallText.samples.push({ selector: sel(el), box: docBox(el.getBoundingClientRect()) })
      }
    }
  }
  return { viewport: vw, scrollWidth: de.scrollWidth, scrollHeight: de.scrollHeight, dpr: window.devicePixelRatio, break: isBreak, offenders, clipped, smallTargets, smallText }
}

export function layoutFlags (testInfo: TestInfo) {
  const m = testInfo.project.metadata as Record<string, any>
  return { touch: !!(testInfo.project.use as any).hasTouch, phone: m.kind === 'phone' }
}

export async function runAudit (page: Page, testInfo: TestInfo, at: string, shot: string | null = null): Promise<LayoutCheck | null> {
  try {
    const r = await page.evaluate(audit, layoutFlags(testInfo))
    return { at, shot, ...r }
  } catch {
    return null
  }
}

/**
 * Many apps (this admin included) scroll inside an inner pane (`h-screen overflow-y-auto`), so the
 * document is only one screen tall and a "full page" screenshot captures just the first screen.
 * Release the fixed heights of every tall scroll pane (and its ancestors) so the document grows to
 * the pane's real content height, measure and capture, then restore. Returns the panes expanded.
 */
export async function expandForCapture (page: Page): Promise<number> {
  return page.evaluate(() => {
    const saved: [HTMLElement, string | null][] = []
    ;(window as any).__rsSaved = saved
    const vh = window.innerHeight
    const panes = [...document.querySelectorAll('*')].filter((el) => {
      if (el.closest('#__rs_demo')) return false
      const cs = getComputedStyle(el)
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4 && el.clientHeight >= vh * 0.5
    })
    const seen = new Set<Element>()
    const release = (h: HTMLElement) => {
      if (seen.has(h)) return
      seen.add(h)
      saved.push([h, h.getAttribute('style')])
      h.style.setProperty('height', 'auto', 'important')
      h.style.setProperty('max-height', 'none', 'important')
    }
    for (const pane of panes) for (let el: Element | null = pane; el; el = el.parentElement) release(el as HTMLElement)
    if (panes.length) for (const root of [document.documentElement, document.body]) { release(root); root.style.setProperty('overflow-y', 'visible', 'important') }
    return panes.length
  }).catch(() => 0)
}
export async function restoreAfterCapture (page: Page) {
  await page.evaluate(() => {
    const saved = ((window as any).__rsSaved ?? []) as [HTMLElement, string | null][]
    for (const [el, style] of saved.reverse()) { if (style === null) el.removeAttribute('style'); else el.setAttribute('style', style) }
    ;(window as any).__rsSaved = []
  }).catch(() => {})
}

export async function hideOverlay (page: Page) {
  await page.evaluate(() => { const o = document.getElementById('__rs_demo'); if (o) o.style.display = 'none' }).catch(() => {})
}
export async function showOverlay (page: Page) {
  await page.evaluate(() => { const o = document.getElementById('__rs_demo'); if (o) o.style.display = '' }).catch(() => {})
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c])
export const TONE = { ok: '#16a34a', bad: '#dc2626', warn: '#d97706', info: '#2563eb' }

/**
 * The figure: sized to its content (never a small shot in a big empty canvas), screenshot scaled up
 * to a readable width, rings + inline labels on the boxes, a legend of ONLY the labelled boxes, and the note.
 */
export function figureHtml ({ img, pageW, pageH, dpr, boxes, title, chips, note, footer }: {
  img: string, pageW: number, pageH: number, dpr: number, boxes: AnnBox[], title: string, chips: string[], note?: string, footer: string
}) {
  const shotW = Math.max(560, Math.min(1180, Math.round(pageW * (pageW < 700 ? 1.45 : 1))))
  const k = shotW / pageW
  const labelled = boxes.filter(b => b.label)
  const legendTone = (t?: Tone) => TONE[t ?? 'info']
  const rings = boxes.map((b, i) => {
    const t = TONE[b.tone ?? 'info']
    const pad = 3
    const x = b.x * k - pad; const y = b.y * k - pad; const w = Math.max(10, b.w * k + pad * 2); const h = Math.max(10, b.h * k + pad * 2)
    const n = b.label ? labelled.indexOf(b) + 1 : 0
    return `<div class="r" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-color:${t}">${n ? `<span class="n" style="background:${t}">${n}</span>` : ''}</div>`
  }).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    body{font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fff;color:#0f172a;padding:22px 26px;width:${shotW + 52}px}
    h1{font-size:19px;line-height:1.25;margin-bottom:8px}
    .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}.chip{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:999px;padding:2px 10px;font-size:12.5px;color:#334155}
    .shot{position:relative;width:${shotW}px;height:${Math.round(pageH * k)}px;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;background:#fff}
    .shot img{display:block;width:100%;height:100%}
    .r{position:absolute;border:3px solid;border-radius:8px;box-shadow:0 0 0 2px #ffffffaa}
    .n{position:absolute;top:-13px;left:-13px;width:25px;height:25px;border-radius:50%;color:#fff;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center;border:2px solid #fff}
    .legend{margin-top:14px;display:grid;gap:6px}.legend div{display:flex;gap:10px;align-items:flex-start;font-size:14.5px}
    .legend b{flex:none;width:23px;height:23px;border-radius:50%;color:#fff;font-size:12.5px;display:flex;align-items:center;justify-content:center}
    .note{margin-top:14px;padding:10px 14px;background:#f1f5f9;border-left:4px solid #2563eb;border-radius:4px;font-size:14.5px}
    .f{margin-top:12px;color:#64748b;font-size:12px;word-break:break-all}
  </style></head><body>
    <h1>${esc(title)}</h1>
    <div class="chips">${chips.map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>
    <div class="shot"><img src="data:image/png;base64,${img}">${rings}</div>
    ${labelled.length ? `<div class="legend">${labelled.map((b, i) => `<div><b style="background:${legendTone(b.tone)}">${i + 1}</b><span>${esc(b.label)}</span></div>`).join('')}</div>` : ''}
    ${note ? `<div class="note">${esc(note)}</div>` : ''}
    <div class="f">${esc(footer)}</div></body></html>`
}

export type SnapOptions = {
  /**
   * Page-coordinate boxes to ring (green = verified, red = wrong, amber = warning). Pass a function
   * to measure them AFTER the page is expanded for capture, so they line up with the image.
   */
  boxes?: AnnBox[] | (() => Promise<AnnBox[]>)
  /** Elements to ring in blue, numbered in the legend. */
  mark?: Locator | Locator[] | { locator: Locator, label: string }[]
  note?: string
  /** Default true. */
  fullPage?: boolean
}

export function evidenceApi (page: Page, testInfo: TestInfo, state: { layout: LayoutCheck[], currentStep: () => string | null, multi: boolean }) {
  let count = 0
  async function snap (name: string, opts: SnapOptions = {}) {
    count++
    const safe = `${String(count).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase()}`
    const fullPage = opts.fullPage !== false

    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {})
    await hideOverlay(page) // narration never belongs in evidence
    const expanded = fullPage ? await expandForCapture(page) : 0
    if (expanded) await page.waitForTimeout(400) // charts and lazy content reflow into the taller layout
    const pageH = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0)

    // Everything below is measured in the expanded layout, in PAGE coordinates, so it lines up with the image.
    const marks = (Array.isArray(opts.mark) ? opts.mark : opts.mark ? [opts.mark] : [])
      .map((m: any) => (typeof m.boundingBox === 'function' ? { locator: m, label: '' } : m))
    const boxes: AnnBox[] = []
    for (const m of marks) {
      const b = await m.locator.first().evaluate((el: Element) => {
        const r = el.getBoundingClientRect()
        const label = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.tagName).toString().replace(/\s+/g, ' ').trim().slice(0, 60)
        return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height, label }
      }, undefined, { timeout: 2000 }).catch(() => null)
      if (b) boxes.push({ x: b.x, y: b.y, w: b.w, h: b.h, tone: 'info', label: m.label || b.label })
    }
    const given = typeof opts.boxes === 'function' ? await opts.boxes().catch(() => []) : (opts.boxes ?? [])
    boxes.push(...given)

    const raw = await page.screenshot({ fullPage })
    const rawPath = testInfo.outputPath(`${safe}.raw.png`)
    fs.writeFileSync(rawPath, raw)
    await testInfo.attach(`${name} · raw`, { path: rawPath, contentType: 'image/png' })

    // Audit with the same capture, so every finding's box lines up with this exact image.
    let auditBoxes = 0
    if (state.multi) {
      const check = await runAudit(page, testInfo, name, rawPath)
      if (check) {
        state.layout.push(check)
        // Ring problems amber / red on the figure; they are explained in the report's findings,
        // so they do not crowd this figure's legend.
        for (const o of check.offenders) { boxes.push({ ...o.box, tone: 'bad' }); auditBoxes++ }
        for (const c of check.clipped) { boxes.push({ ...c.box, tone: 'bad' }); auditBoxes++ }
        for (const t of check.smallTargets.slice(0, 8)) { boxes.push({ ...t.box, tone: 'warn' }); auditBoxes++ }
      }
    }
    await restoreAfterCapture(page)
    await showOverlay(page)

    const m = testInfo.project.metadata as Record<string, any>
    const vp = page.viewportSize() ?? { width: 1280, height: 800 }
    const pageW = vp.width
    const dpr = (testInfo.project.use as any).deviceScaleFactor ?? 1
    const footer = [process.env.E2E_TICKET || 'adhoc', process.env.ENV || 'local', new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }),
      (() => {
        try {
          const u = new URL(page.url())
          if (u.protocol === 'about:') return 'inline test page'
          /* A local file shows only its name: the full path would put the machine's user and folders on every figure. */
          if (u.protocol === 'file:') return `${u.pathname.split('/').pop()} (local file)`
          return u.host + u.pathname
        } catch { return '' }
      })()].filter(Boolean).join(' · ')
    const noteBits = [opts.note, auditBoxes ? 'Amber / red rings: layout problems on this screen (see Findings in the report).' : null].filter(Boolean).join('  ')

    const browser = page.context().browser()
    if (!browser) return rawPath
    const fig = await browser.newPage({ viewport: { width: 1300, height: 900 }, deviceScaleFactor: 2 })
    try {
      await fig.setContent(figureHtml({
        img: raw.toString('base64'), pageW, pageH, dpr, boxes,
        title: (() => { const step = state.currentStep(); return !step || step.toLowerCase().includes(name.toLowerCase()) ? (step ?? name) : `${step} — ${name}` })(),
        chips: [m.deviceLabel, m.browserLabel].filter(Boolean), note: noteBits || undefined, footer,
      }))
      const figPath = testInfo.outputPath(`${safe}.png`)
      await fig.locator('body').screenshot({ path: figPath }) // the content box only: no empty canvas
      await testInfo.attach(name, { path: figPath, contentType: 'image/png' })
      return figPath
    } finally {
      await fig.close()
    }
  }
  return { snap }
}
