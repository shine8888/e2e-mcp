// Annotated crops for findings: zoom on the element, ring it, point at it, say what is wrong,
// and show where it sits on the page. One PNG per (defect, screen), written to <run>/findings/.
//
// The input is the raw FULL-PAGE screenshot the layout audit was measured on (device pixel
// ratio applied) and the element's box in page CSS pixels, so the ring always lands exactly
// on the element. Rendered by Playwright's Chromium (already a harness dependency).
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { esc } from './results.mjs'

export const TONES = { bad: '#dc2626', warn: '#d97706', ok: '#16a34a', info: '#2563eb' }

function pngSize (buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } }

/** Region of the page (CSS px) to show: the box, plus context, clamped to the page. */
export function regionFor (box, pageW, pageH) {
  const w = Math.min(pageW, Math.max(520, box.w + 300))
  // A tall element (a whole card) would make an unreadable 6000px crop: show its top part, ring and label.
  const h = Math.min(pageH, Math.min(820, Math.max(320, box.h + 240)))
  const cx = box.x + box.w / 2
  const cy = box.y + Math.min(box.h / 2, 330)
  return { x: Math.max(0, Math.min(pageW - w, cx - w / 2)), y: Math.max(0, Math.min(pageH - h, cy - h / 2)), w, h }
}

export function cropHtml ({ img, pageW, pageH, dpr = 2, box, tone, label, screen, id, severity }) {
  const OUT = 1000 // CSS px width of the crop on screen (rendered at 2x)
  const reg = regionFor(box, pageW, pageH)
  const s = Math.min(dpr * 1.25, OUT / reg.w)
  const W = Math.round(reg.w * s)
  const H = Math.round(reg.h * s)
  const col = TONES[tone] ?? TONES.bad
  // Ring: at least 40px so a 2px-wide control is still obvious.
  const rw = Math.max(40, box.w * s + 16)
  const rh = Math.max(40, box.h * s + 16)
  const rx = (box.x - reg.x) * s + (box.w * s - rw) / 2
  const ry = (box.y - reg.y) * s + (box.h * s - rh) / 2
  // Label under the ring when there is room, else above; always kept inside the crop.
  const below = ry + rh + 70 < H && rh < H * 0.8
  const lx = Math.max(10, Math.min(W - 460, rx - 10))
  const ly = below ? ry + rh + 16 : (ry > 70 ? Math.max(8, ry - 62) : Math.max(8, Math.min(H - 90, ry + 14)))
  // Where on the page: the whole page, scaled to fit 200x320, with a marker.
  const t = Math.min(190 / pageW, 420 / pageH)
  const tw = Math.round(pageW * t)
  const th = Math.round(pageH * t)
  const SIDE = 230
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    body{font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;width:${W + SIDE}px;background:#fff;color:#0f172a}
    .bar{display:flex;justify-content:space-between;gap:12px;padding:10px 16px;background:#0f172a;color:#fff;font-size:14px}
    .bar b{color:${col === TONES.bad ? '#fca5a5' : '#fcd34d'}}
    .row{display:flex;align-items:flex-start}
    .wrap{position:relative;flex:none;width:${W}px;height:${H}px;overflow:hidden;border-right:1px solid #cbd5e1;border-bottom:1px solid #cbd5e1}
    .wrap img{position:absolute;width:${Math.round(pageW * s)}px;left:${-Math.round(reg.x * s)}px;top:${-Math.round(reg.y * s)}px;max-width:none}
    .ring{position:absolute;left:${rx}px;top:${ry}px;width:${rw}px;height:${rh}px;border:5px solid ${col};border-radius:12px;box-shadow:0 0 0 4px #fff,0 0 0 9px ${col}55}
    .lab{position:absolute;left:${lx}px;top:${ly}px;max-width:450px;background:${col};color:#fff;border-radius:8px;padding:8px 14px;font-weight:650;font-size:17px;line-height:1.3;box-shadow:0 4px 14px #0004}
    .lab small{display:block;font-weight:500;font-size:13px;opacity:.95}
    .side{flex:none;width:${SIDE}px;padding:14px;background:#f8fafc;min-height:${H}px;border-bottom:1px solid #cbd5e1}
    .side h4{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin-bottom:8px}
    .loc{position:relative;width:${tw}px;height:${th}px;background:#f1f5f9;overflow:hidden;border:2px solid #475569;border-radius:6px}
    .loc img{width:100%;height:100%;display:block}
    .loc i{position:absolute;left:${box.x * t - 6}px;top:${box.y * t - 6}px;width:${Math.max(14, box.w * t + 12)}px;height:${Math.max(14, box.h * t + 12)}px;border:3px solid ${col};border-radius:6px;box-shadow:0 0 0 2px #fff}
    .side p{font-size:12.5px;color:#475569;margin-top:12px;word-break:break-word}
  </style></head><body>
    <div class="bar"><span><b>${esc(id)}</b> · ${esc(severity)} · ${esc(screen)}</span><span>page ${pageW}×${pageH}px</span></div>
    <div class="row"><div class="wrap"><img src="data:image/png;base64,${img}">
      <div class="ring"></div>
      <div class="lab">${esc(label.title)}${label.sub ? `<small>${esc(label.sub)}</small>` : ''}</div>
    </div>
    <div class="side"><h4>Where on the page</h4><div class="loc"><img src="data:image/png;base64,${img}"><i></i></div>
      <p><b>Element</b><br>${box.w}×${box.h}px at (${Math.round(box.x)}, ${Math.round(box.y)})</p></div></div></body></html>`
}

export async function renderCrops (jobs, outDir) {
  const done = []
  if (!jobs.length) return done
  fs.mkdirSync(outDir, { recursive: true })
  let browser
  try { browser = await chromium.launch() } catch { return done }
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 })
    for (const j of jobs) {
      if (!j.raw || !fs.existsSync(j.raw)) continue
      const buf = fs.readFileSync(j.raw)
      const { w, h } = pngSize(buf)
      const dpr = j.dpr || 1
      await page.setContent(cropHtml({ ...j, img: buf.toString('base64'), pageW: Math.round(w / dpr), pageH: Math.round(h / dpr) }))
      await page.waitForLoadState('load')
      const out = path.join(outDir, j.file)
      await page.locator('body').screenshot({ path: out })
      done.push({ ...j, out })
    }
  } finally {
    await browser.close()
  }
  return done
}
