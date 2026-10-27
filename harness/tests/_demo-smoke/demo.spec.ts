// Login-free check of the recording + narration pipeline. No Fintary app is
// involved: the page is a stand-in statement search form served from memory, so this
// runs anywhere, with no stack and no VPN.
//   node bin/ft-e2e-run.mjs run --ticket _demo-smoke --demo --skip-preflight
import { test, expect } from '../../fixtures'

const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px -apple-system,sans-serif;margin:0;background:#f8fafc}main{max-width:720px;margin:48px auto;padding:32px;background:#fff;border-radius:12px;box-shadow:0 2px 12px #0001}
label{display:block;margin:14px 0 6px;font-weight:600}input,select{font-size:16px;padding:10px;width:100%;box-sizing:border-box}button{margin-top:20px;font-size:17px;padding:12px 22px;background:#1d4ed8;color:#fff;border:0;border-radius:8px}
#result{margin-top:22px;font-size:18px}</style></head><body><main>
<h1>Demo statement search</h1>
<label for="month">Statement month</label><input id="month" type="month">
<label for="carrier">Carrier</label><select id="carrier"><option>Stub Life</option><option>Example Mutual</option><option>Demo Health</option></select>
<label for="agent">Agent code</label><input id="agent" placeholder="Agent code">
<button onclick="document.getElementById('result').textContent='3 statements found for '+document.getElementById('carrier').value">Find statements</button>
<p id="result" role="status"></p></main></body></html>`

test('demo smoke: search commission statements', async ({ page, demo, evidence }) => {
  await test.step('Open the statement search page', async () => {
    await page.setContent(PAGE)
    await expect(page.getByRole('heading', { name: 'Demo statement search' })).toBeVisible()
  })
  await test.step('Pick a month, a carrier and an agent', async () => {
    await page.getByLabel('Statement month').fill('2030-01')
    await page.getByLabel('Carrier').selectOption('Example Mutual')
    await page.getByPlaceholder('Agent code').fill('E2E-AGENT-7')
  })
  await test.step('Find statements', async () => {
    await page.getByRole('button', { name: 'Find statements' }).click()
    const result = page.getByRole('status')
    await expect(result).toHaveText('3 statements found for Example Mutual')
    await demo.circle(result, 'Statements found')
    await demo.callout('Statements returned for the selected carrier')
    await evidence.snap('statement result', { mark: result, note: 'The result line names the carrier picked in step 2.' })
  })
})
