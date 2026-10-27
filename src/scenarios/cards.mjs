// Title / per-test / summary cards for the stitched demo video, rendered as
// PNGs by screenshotting HTML. Two reasons it is done this way: this machine's
// ffmpeg has no drawtext (built without libfreetype), and a browser gives the
// cards the same typography as the captions burned into the recordings.
// Playwright is borrowed from the harness, so the server adds no browser
// dependency of its own (Playwright's Chromium -- no Chrome.app needed).
import path from 'node:path'
import { createRequire } from 'node:module'
import { FT_E2E_DIR } from '../ft-e2e.mjs'

export const FRAME = { width: 1600, height: 1000 }

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const shell = body => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${FRAME.width}px; height: ${FRAME.height}px; background: #0f172a; color: #e2e8f0;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         display: flex; flex-direction: column; justify-content: center; padding: 0 140px; }
  .eyebrow { color: #fbbf24; font-size: 26px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  h1 { font-size: 66px; line-height: 1.12; font-weight: 750; color: #fff; margin: 18px 0 26px; }
  .meta { font-size: 25px; color: #94a3b8; line-height: 1.6; }
  .pill { display: inline-block; padding: 8px 22px; border-radius: 999px; font-weight: 750; font-size: 28px; }
  .pass { background: #14532d; color: #86efac; } .fail { background: #7f1d1d; color: #fca5a5; }
  .skip { background: #3f3f46; color: #d4d4d8; }
  ul { list-style: none; padding: 0; margin-top: 28px; font-size: 27px; line-height: 1.75; }
  li span { display: inline-block; width: 110px; font-weight: 750; }
  .ok { color: #86efac; } .bad { color: #fca5a5; } .dim { color: #a1a1aa; }
  .footer { position: absolute; bottom: 44px; left: 140px; font-size: 20px; color: #475569; }
</style></head><body>${body}<div class="footer">Fintary · ft-e2e · recorded test run</div></body></html>`

const statusPill = status => (status === 'passed'
  ? '<span class="pill pass">PASS</span>'
  : status === 'skipped' ? '<span class="pill skip">SKIPPED</span>' : '<span class="pill fail">FAIL</span>')

export function titleCardHtml ({ ticket, envLabel, startedAt, testCount, stamps }) {
  return shell(`
    <div class="eyebrow">${esc(ticket)} · ${esc(envLabel)}</div>
    <h1>End-to-end test report</h1>
    <div class="meta">${testCount} test${testCount === 1 ? '' : 's'} · recorded ${esc(startedAt)}</div>
    <div class="meta" style="margin-top:22px">${stamps.map(esc).join('<br>')}</div>`)
}

export function testCardHtml ({ index, total, title, status, durationMs }) {
  return shell(`
    <div class="eyebrow">Test ${index} of ${total}</div>
    <h1>${esc(title)}</h1>
    <div>${statusPill(status)} <span class="meta" style="margin-left:18px">${(durationMs / 1000).toFixed(1)}s</span></div>`)
}

export function summaryCardHtml ({ ticket, envLabel, headline, tests }) {
  const rows = tests.map(t => {
    const mark = t.status === 'passed' ? '<span class="ok">✓ PASS</span>'
      : t.status === 'skipped' ? '<span class="dim">– SKIP</span>' : '<span class="bad">✗ FAIL</span>'
    return `<li>${mark} ${esc(t.title)}</li>`
  }).join('')
  return shell(`
    <div class="eyebrow">${esc(ticket)} · ${esc(envLabel)} · result</div>
    <h1 style="font-size:54px">${esc(headline)}</h1>
    <ul>${rows}</ul>`)
}

/**
 * Screenshots each HTML card to `<dir>/<name>.png`.
 * @param {{ name: string, html: string }[]} cards
 * @param {string} dir
 * @returns {Promise<string[]>} the PNG paths, in order
 */
export async function renderCards (cards, dir) {
  const req = createRequire(path.join(FT_E2E_DIR, 'package.json'))
  const { chromium } = req('@playwright/test')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: FRAME })
    const out = []
    for (const card of cards) {
      await page.setContent(card.html)
      const file = path.join(dir, `${card.name}.png`)
      await page.screenshot({ path: file })
      out.push(file)
    }
    return out
  } finally {
    await browser.close()
  }
}
