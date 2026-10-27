// Signed-in check against a REAL environment: the test user's session opens the app,
// the Policies page renders its grid, and the API accepts the same user's ID token.
// READ-ONLY. Needs E2E_EMAIL / E2E_PASSWORD in harness/.env.<env> (or E2E_UID on local).
//   node bin/ft-e2e-run.mjs run --ticket _app-smoke --env dev
import { appTest as test, expect } from '../../fixtures'

const MENU = '[data-testid="user-menu-button"]'

test('app smoke: signed in, Policies grid, API with the same session', async ({ page, app, apiFor, evidence, demo }) => {
  let accountId = ''

  await test.step('Open the app signed in', async () => {
    await page.goto(app.url('/'))
    await expect(page.locator(MENU)).toBeVisible({ timeout: 60_000 })
    expect(new URL(page.url()).pathname, 'the session did not hold: the app sent us to sign in').not.toMatch(/^\/sign-in/)
    // The account the app is on: the one asked for (E2E_ACCOUNT_ID), else the user's default.
    await expect.poll(async () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('selectedAccount') || 'null')?.accountId ?? '' } catch { return '' } }), { timeout: 30_000 }).not.toBe('')
    accountId = await page.evaluate(() => JSON.parse(localStorage.getItem('selectedAccount') || '{}').accountId)
    if (app.accountId) expect(accountId, 'the app opened another account than E2E_ACCOUNT_ID').toBe(app.accountId)
    await demo.circle(page.locator(MENU), 'Signed in')
  })

  await test.step('Policies shows its grid', async () => {
    await page.goto(app.url('/policies'))
    const grid = page.locator('.MuiDataGrid-root, table').first()
    await expect(grid).toBeVisible({ timeout: 60_000 })
    const headers = page.locator('.MuiDataGrid-root [role=columnheader], table th')
    await expect.poll(() => headers.count(), { timeout: 30_000, message: 'the Policies grid rendered no column headers' }).toBeGreaterThan(1)
    const names = (await headers.allInnerTexts()).map(t => t.trim()).filter(Boolean)
    await evidence.snap('policies grid', {
      mark: grid,
      note: `Policies rendered a grid with ${names.length} column header(s): ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}.`,
    })
  })

  await test.step('The API accepts the same session', async () => {
    const api = await apiFor(app.env.apiURL, { auth: true, headers: { accountid: accountId } })
    const res = await api.get('api/check')
    expect(res.status(), 'GET api/check with the session\'s ID token').toBe(200)
    const body = await res.json()
    test.info().annotations.push({ type: 'context', description: `account ${accountId}${body.isFintaryAdmin ? ' · Fintary admin' : ''} · api ${String(body.commitSha ?? 'unknown').slice(0, 10)}` })
    test.info().annotations.push({ type: 'verified', description: JSON.stringify({ tab: 'Session', what: 'checks (app menu, grid, API)', count: 3, wrong: 0, expected: 'signed in' }) })
  })
})
