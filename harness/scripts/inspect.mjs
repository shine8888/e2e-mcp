#!/usr/bin/env node
// Selector reconnaissance against a LIVE page: what is actually in the DOM,
// before anyone writes a locator.
//
//   node scripts/inspect.mjs <route> [--env dev|uat|local] [--account <str_id>] [--public] [--wait <ms>]
//
//   <route> is a web-app path, e.g. "/policies", "/agents/list", "/settings/general".
//   Signed in by default (the cached session, .auth/<env>.json; signs in first when it is dead);
//   --public, or a public route (/sign-in, /debug, /reset, /maintenance), opens it without a session.
//   A full http(s) URL is opened as-is.
//
// The web is MUI v7 with sparse data-testid attributes (about 48), so the useful handles are
// ids on inputs (#emailAddress), accessible names (buttons, tabs, dialogs), DataGrid column
// headers, and the Mui* component classes. All are listed.
// Prints one JSON object; the screenshot goes to tickets/_inspect/.
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import cfg from '../lib/config.cjs'
import firebase from '../lib/firebase.cjs'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1] }
const route = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? '/'
const env = cfg.envConfig(opt('env', process.env.ENV || cfg.registry().default))
const account = opt('account', env.accountId)
const waitMs = Number(opt('wait', 6000))
const app = argv.includes('--public') || /^\/(sign-in|debug|reset|maintenance|auth\/action|terms-of-service|l\/)/.test(route) ? 'public' : 'app'
const url = /^https?:\/\//.test(route) ? route : cfg.webUrl(env, route)

let storageState
if (app === 'app') {
  try { storageState = await firebase.ensureSession(env) } catch (err) { console.error(err.message); process.exit(3) }
}
const GUARD = new RegExp(`^https://(${cfg.writeGuardHosts().map(h => h.replace(/\./g, '\\.')).join('|')})/`)

const browser = await chromium.launch()
const consoleErrors = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState, ignoreHTTPSErrors: true })
  // Same production write guard as the fixtures.
  await context.route(GUARD, r => (['GET', 'HEAD', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort('blockedbyclient')))
  if (app === 'app' && account) {
    await context.addInitScript((id) => { try { localStorage.setItem('selectedAccount', JSON.stringify({ accountId: id })) } catch {} }, account)
  }
  const page = await context.newPage()
  page.on('console', m => { if (m.type() === 'error' && consoleErrors.length < 30) consoleErrors.push(m.text().slice(0, 300)) })
  page.on('pageerror', e => { if (consoleErrors.length < 30) consoleErrors.push(`pageerror: ${String(e.message).slice(0, 300)}`) })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // The app keeps polling (feature flags every minute), so networkidle is capped rather than awaited forever.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(waitMs)

  const dom = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' }
    const txt = s => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
    const labelFor = (el) => {
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label')
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return txt(l.innerText) }
      const l = el.closest('label'); return l ? txt(l.innerText) : null
    }
    const testIds = [...document.querySelectorAll('[data-testid],[data-test],[data-cy],[data-qa]')].slice(0, 60).map(el => ({
      attr: ['data-testid', 'data-test', 'data-cy', 'data-qa'].find(a => el.hasAttribute(a)),
      value: el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-cy') ?? el.getAttribute('data-qa'),
      tag: el.tagName.toLowerCase(), visible: vis(el),
    }))
    const classCount = {}
    for (const el of document.querySelectorAll('[class]')) {
      if (!vis(el)) continue
      const cls = [...el.classList]
      const mods = cls.filter(c => /^Mui-(selected|disabled|checked|expanded|focused|error|active)$/.test(c))
      for (const c of cls) {
        if (!/^Mui(DataGrid|Tab|Tabs|Chip|Alert|Dialog|Drawer|Button|IconButton|Select|Autocomplete|TextField|Card|Accordion|Stepper|Menu|Toolbar|Breadcrumbs|Pagination|Switch|Checkbox)\b/.test(c)) continue
        classCount[c] = (classCount[c] ?? 0) + 1
        // State classes (Mui-selected, Mui-disabled, Mui-checked) live alongside: count each pairing.
        for (const m of mods) { const k = `${c}.${m}`; classCount[k] = (classCount[k] ?? 0) + 1 }
      }
    }
    const stableClasses = Object.entries(classCount).sort((a, b) => b[1] - a[1]).slice(0, 80).map(([cls, count]) => ({ selector: `.${cls}`, count }))
    return {
      title: document.title,
      headings: [...document.querySelectorAll('h1,h2,h3,h4')].filter(vis).slice(0, 40).map(h => ({ level: h.tagName.toLowerCase(), text: txt(h.innerText) })),
      buttons: [...document.querySelectorAll('button,[role=button],input[type=submit]')].filter(vis).slice(0, 60).map(b => ({
        name: txt(b.getAttribute('aria-label') || b.innerText || b.value), disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true', classes: [...b.classList].slice(0, 3).join(' ') || null,
      })),
      inputs: [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(vis).slice(0, 60).map(i => ({
        tag: i.tagName.toLowerCase(), type: i.type || null, name: i.name || null, placeholder: i.placeholder || null, label: labelFor(i), id: i.id || null,
      })),
      links: [...document.querySelectorAll('a[href]')].filter(vis).slice(0, 40).map(a => ({ text: txt(a.innerText || a.getAttribute('aria-label')), href: a.getAttribute('href') })),
      tables: [...document.querySelectorAll('table')].filter(vis).slice(0, 10).map(t => ({ headers: [...t.querySelectorAll('th')].slice(0, 15).map(th => txt(th.innerText)), rows: t.querySelectorAll('tbody tr').length })),
      ariaLabels: [...document.querySelectorAll('[aria-label]')].filter(vis).slice(0, 50).map(el => ({ tag: el.tagName.toLowerCase(), label: el.getAttribute('aria-label') })),
      iframes: [...document.querySelectorAll('iframe')].map(f => { let host = null; try { host = new URL(f.src, location.href).host } catch {} return { title: f.title || null, host } }),
      grids: [...document.querySelectorAll('.MuiDataGrid-root')].filter(vis).slice(0, 5).map(g => ({
        columns: [...g.querySelectorAll('[role=columnheader]')].slice(0, 25).map(h => txt(h.getAttribute('aria-label') || h.innerText)),
        rows: g.querySelectorAll('[role=row][data-rowindex], .MuiDataGrid-row').length,
        rowCountText: txt(g.querySelector('.MuiTablePagination-displayedRows, .MuiDataGrid-rowCount')?.textContent),
      })),
      tabs: [...document.querySelectorAll('[role=tab]')].filter(vis).slice(0, 30).map(t => ({ name: txt(t.innerText || t.getAttribute('aria-label')), selected: t.getAttribute('aria-selected') === 'true' })),
      dialogs: [...document.querySelectorAll('[role=dialog]')].filter(vis).map(d => txt(d.querySelector('h2,h3,.MuiDialogTitle-root')?.textContent)),
      testIds,
      stableClasses,
    }
  })

  const outDir = path.join(cfg.HARNESS_DIR, 'tickets', '_inspect')
  fs.mkdirSync(outDir, { recursive: true })
  const slug = `${env.name}-${app}-${(route.replace(/^https?:\/\/[^/]+/, '') || 'root').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'root'}`
  const screenshot = path.join(outDir, `${slug}.png`)
  await page.screenshot({ path: screenshot, fullPage: true })
  const finalUrl = page.url()
  console.log(JSON.stringify({
    env: env.name, app, url, finalUrl,
    account: app === 'app' ? (account || '(user default)') : null,
    redirectedToLogin: app === 'app' && /\/sign-in/.test(new URL(finalUrl).pathname),
    ...dom,
    testIdNote: dom.testIds.length ? null : 'No data-testid / data-test / data-cy on this page (data-testid is sparse in the Fintary web): use getByRole / getByLabel / #id, or a stableClasses selector.',
    consoleErrors,
    screenshot,
  }, null, 2))
} finally {
  await browser.close()
}
