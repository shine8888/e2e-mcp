// Login-free check of the multi-device layout audit. The page plants two faults
// on purpose: a 640px table (a sideways-scroll BREAK on phones, fine on tablet
// and desktop) and an 18px button (a touch-target WARNING on touch screens).
//   node bin/ft-e2e-run.mjs run --ticket _device-smoke --devices --skip-preflight
import { test, expect } from '../../fixtures'

const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px -apple-system,sans-serif;margin:0;padding:16px}table{width:640px;border-collapse:collapse}td{border:1px solid #cbd5e1;padding:8px}
#tiny{width:18px;height:18px;padding:0;border:1px solid #334155;border-radius:4px;background:#e2e8f0}</style></head><body>
<h1>Rate table</h1><div id="out"><table><tr><td>Room</td><td>Rate</td><td>Mon</td><td>Tue</td><td>Wed</td><td>Thu</td></tr>
<tr><td>Deluxe</td><td>BAR</td><td>$289</td><td>$289</td><td>$310</td><td>$310</td></tr></table></div>
<p>Close <button id="tiny" aria-label="Close">×</button></p></body></html>`

test('device smoke: rate table and close button', async ({ page, evidence }) => {
  await test.step('Open the rate table', async () => {
    await page.setContent(PAGE)
    await expect(page.getByRole('heading', { name: 'Rate table' })).toBeVisible()
  })
  await test.step('Snap the planted layout', async () => {
    await evidence.snap('planted layout', { mark: page.locator('table'), note: 'A 640px table and an 18px button, planted on purpose.' })
  })
})
