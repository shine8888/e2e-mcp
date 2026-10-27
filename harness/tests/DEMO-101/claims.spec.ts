// DEMO-101: Northstar Claims, a fictional claims desk (app/claims.html, no backend, no product data).
// Shows the harness end to end without touching a real app: sign-in, filters, an approval
// with a confirm dialog, and form validation. The claims table has a fixed 980px width on
// purpose, so a device run reports a sideways-scroll break on phones.
// READ-ONLY: all state lives in the page's memory and resets on every test.
//   node bin/ft-e2e-run.mjs run --ticket DEMO-101 --env local --demo --skip-preflight
//   node bin/ft-e2e-run.mjs run --ticket DEMO-101 --env local --devices desktop,tablet,mobile --skip-preflight
import path from 'node:path'
import { test, expect } from '../../fixtures'
import type { Page } from '@playwright/test'

const APP = `file://${path.join(__dirname, 'app', 'claims.html')}`
const USER = { email: 'alex@northstar.test', password: 'demo-pass' }

async function signIn (page: Page) {
  await page.goto(`${APP}#/login`)
  await page.getByLabel('Email').fill(USER.email)
  await page.getByLabel('Password').fill(USER.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Claims', level: 1 })).toBeVisible()
}

const kpi = (page: Page, name: string) => page.getByLabel(name, { exact: true }).locator('b')
const rows = (page: Page) => page.getByRole('table', { name: 'Claims' }).locator('tbody tr')

test('DEMO-101 TC-01 Sign in and see the claims summary', async ({ page, evidence, demo }) => {
  await test.step('A wrong password is refused', async () => {
    await page.goto(`${APP}#/login`)
    await page.getByLabel('Email').fill(USER.email)
    await page.getByLabel('Password').fill('wrong-password')
    await page.getByRole('button', { name: 'Sign in' }).click()
    const alert = page.getByRole('alert')
    await expect(alert).toHaveText('Email or password is incorrect.')
    await demo.circle(alert, 'Refused')
  })

  await test.step('The right password opens the claims desk', async () => {
    await page.getByLabel('Password').fill(USER.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: 'Claims', level: 1 })).toBeVisible()
    await expect(page).toHaveURL(/#\/claims$/)
  })

  await test.step('The summary counts match the claims', async () => {
    const expected = { 'Open claims': '3', 'Claims in review': '3', 'Approved claims': '1', 'Paid out': '$8,320.00' }
    for (const [name, value] of Object.entries(expected)) await expect(kpi(page, name), name).toHaveText(value)
    await expect(rows(page)).toHaveCount(10)
    await demo.circle(page.getByLabel('Summary'), 'Counts match')
    await evidence.snap('claims summary', {
      mark: page.getByLabel('Summary'),
      note: 'After sign-in, the summary shows 3 open, 3 in review, 1 approved and 8,320 dollars paid out, matching the 10 claims in the table.',
    })
    test.info().annotations.push({ type: 'verified', description: JSON.stringify({ tab: 'Claims', what: 'summary values', count: 5, wrong: 0, expected: 'match the table' }) })
  })
})

test('DEMO-101 TC-02 Filter by status and search by name', async ({ page, evidence, demo }) => {
  await test.step('Sign in', async () => { await signIn(page) })

  await test.step('Status In review shows only claims in review', async () => {
    await page.getByLabel('Status').selectOption('In review')
    await expect(rows(page)).toHaveCount(3)
    const pills = await rows(page).locator('td:last-child').allInnerTexts()
    expect(pills.map(t => t.trim()), `statuses seen: ${pills.join(', ')}`).toEqual(['In review', 'In review', 'In review'])
    await expect(page.getByText('Showing 3 of 10 claims')).toBeVisible()
    await demo.circle(page.getByRole('table', { name: 'Claims' }), '3 in review')
    await evidence.snap('in review filter', {
      mark: page.getByRole('table', { name: 'Claims' }),
      note: 'Filtering by In review leaves exactly 3 claims, and every one of them is in review.',
    })
  })

  await test.step('Searching for Rivera finds one claim', async () => {
    await page.getByLabel('Status').selectOption('All')
    await page.getByLabel('Search').fill('Rivera')
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toContainText('CLM-1042')
    await expect(rows(page).first()).toContainText('Maria Rivera')
    await demo.circle(rows(page).first(), 'CLM-1042')
    await evidence.snap('search rivera', {
      mark: rows(page).first(),
      note: 'Searching for Rivera returns one claim, CLM-1042 for Maria Rivera.',
    })
    test.info().annotations.push({ type: 'verified', description: JSON.stringify({ tab: 'Claims', what: 'filter and search results', count: 5, wrong: 0, expected: 'only matching claims' }) })
  })
})

test('DEMO-101 TC-03 Approve a claim through the confirm dialog', async ({ page, evidence, demo }) => {
  await test.step('Sign in and open CLM-1042', async () => {
    await signIn(page)
    await rows(page).filter({ hasText: 'CLM-1042' }).click()
    await expect(page.getByRole('heading', { name: /CLM-1042/ })).toBeVisible()
  })

  await test.step('Approve asks for confirmation first', async () => {
    await page.getByRole('button', { name: 'Approve claim' }).click()
    const dialog = page.getByRole('dialog', { name: 'Approve CLM-1042?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('$4,820.00 will be released to Maria Rivera')
    await demo.circle(dialog, 'Confirm first')
  })

  await test.step('Confirming approves the claim and records it', async () => {
    await page.getByRole('button', { name: 'Approve $4,820.00' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('status')).toHaveText('CLM-1042 approved for $4,820.00')
    await expect(page.locator('#claim-status')).toHaveText('Approved')
    await expect(page.getByLabel('History')).toContainText('Approved by Alex Morgan')
    await expect(page.getByRole('button', { name: 'Approve claim' })).toBeDisabled()
    await demo.circle(page.locator('#claim-status'), 'Approved')
    await evidence.snap('claim approved', {
      mark: [page.locator('#claim-status'), page.getByLabel('History')],
      note: 'CLM-1042 is now approved, the history names Alex Morgan, and the approve button is disabled.',
    })
  })

  await test.step('The summary moves the claim from review to approved', async () => {
    await page.getByRole('link', { name: '← Back to claims' }).click()
    await expect(kpi(page, 'Claims in review')).toHaveText('2')
    await expect(kpi(page, 'Approved claims')).toHaveText('2')
    await demo.circle(page.getByLabel('Summary'), '2 in review · 2 approved')
    test.info().annotations.push({ type: 'verified', description: JSON.stringify({ tab: 'Claim detail', what: 'approval effects', count: 6, wrong: 0, expected: 'approved everywhere' }) })
  })
})

test('DEMO-101 TC-04 New claim checks every field before saving', async ({ page, evidence, demo }) => {
  await test.step('Sign in and open New claim', async () => {
    await signIn(page)
    await page.getByRole('link', { name: 'New claim' }).first().click()
    await expect(page.getByRole('heading', { name: 'New claim' })).toBeVisible()
  })

  await test.step('An empty form names every missing field', async () => {
    await page.getByRole('button', { name: 'Submit claim' }).click()
    const expected = {
      claimant: 'Enter the claimant name.', policy: 'Use the format POL-12345.', type: 'Choose a claim type.',
      amount: 'Enter an amount above 0.', incident: 'Enter the incident date.',
    }
    for (const [id, text] of Object.entries(expected)) await expect(page.locator(`#${id}-err`), id).toHaveText(text)
    await demo.circle(page.getByRole('form', { name: 'New claim' }), '5 fields flagged')
    await evidence.snap('empty form errors', {
      mark: page.getByRole('form', { name: 'New claim' }),
      note: 'Submitting an empty form flags all five fields, each with its own message, and saves nothing.',
    })
  })

  await test.step('A future incident date is refused', async () => {
    const future = new Date(); future.setDate(future.getDate() + 3)
    await page.getByLabel('Claimant name').fill('Sam Carter')
    await page.getByLabel('Policy number').fill('POL-63018')
    await page.getByLabel('Claim type').selectOption('Home')
    await page.getByLabel('Amount (USD)').fill('2450')
    await page.getByLabel('Incident date').fill(future.toISOString().slice(0, 10))
    await page.getByRole('button', { name: 'Submit claim' }).click()
    const err = page.locator('#incident-err')
    await expect(err).toHaveText("The incident date can't be in the future.")
    await demo.circle(err, 'Future date refused')
  })

  await test.step('A valid claim is saved at the top of the list', async () => {
    const past = new Date(); past.setDate(past.getDate() - 2)
    await page.getByLabel('Incident date').fill(past.toISOString().slice(0, 10))
    await page.getByRole('button', { name: 'Submit claim' }).click()
    await expect(page.getByRole('status')).toHaveText('CLM-1043 created for Sam Carter')
    const first = rows(page).first()
    await expect(first).toContainText('CLM-1043')
    await expect(first).toContainText('Open')
    await expect(kpi(page, 'Open claims')).toHaveText('4')
    await demo.circle(first, 'New claim, Open')
    await evidence.snap('new claim saved', {
      mark: first,
      note: 'The new claim CLM-1043 for Sam Carter is saved as open at the top of the list, and the open count rises to 4.',
    })
    test.info().annotations.push({ type: 'verified', description: JSON.stringify({ tab: 'New claim', what: 'validation and save', count: 10, wrong: 0, expected: 'errors until valid, then saved' }) })
  })
})
