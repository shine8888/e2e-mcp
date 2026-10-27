// Login-free check against a REAL environment: the web app serves its sign-in page,
// the form behaves, and the API answers its healthcheck. No account, no session,
// no write (the email field is left empty, so the form never calls check-contact).
//   node bin/ft-e2e-run.mjs run --ticket _web-smoke --env dev
import { test, expect } from '../../fixtures'

test('web smoke: sign-in page, form state and API health', async ({ page, app, publicApi, evidence, demo }) => {
  await test.step('Open the sign-in page', async () => {
    await page.goto(app.url('/sign-in'))
    await expect(page.getByRole('heading', { name: 'Fintary', level: 1 })).toBeVisible({ timeout: 45_000 })
    await expect(page.locator('#emailAddress')).toBeVisible()
    await expect(page.locator('#password')).toBeVisible()
  })

  await test.step('The primary button follows the form', async () => {
    // No password yet: the primary action is the email link, disabled until an address is typed.
    const link = page.getByRole('button', { name: 'Send sign-in link' })
    await expect(link).toBeDisabled()
    await demo.circle(link, 'Disabled with no email')
    // A password switches it to "Sign In" (still disabled: no address).
    await page.locator('#password').fill('not-a-real-password')
    const signIn = page.getByRole('button', { name: 'Sign In', exact: true })
    await expect(signIn).toBeVisible()
    await expect(signIn).toBeDisabled()
    await evidence.snap('sign-in form', {
      mark: signIn,
      note: 'With a password and no email the primary button reads "Sign In" and stays disabled. Nothing was submitted.',
    })
    test.info().annotations.push({ type: 'verified', description: JSON.stringify({ tab: 'Sign-in page', what: 'form states', count: 2, wrong: 0, expected: 'as designed' }) })
  })

  await test.step('The API answers its healthcheck', async () => {
    const res = await publicApi.get('api/healthcheck')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    test.info().annotations.push({ type: 'context', description: `${app.env.label}: api image from ${String(body.commitSha ?? 'unknown').slice(0, 10)}` })
  })
})
