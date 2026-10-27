#!/usr/bin/env node
// devices.html -> A4 PDF with page numbers (the attachment publish posts to Linear).
//   node scripts/report-pdf.mjs <ticket> <env> <run id> <out.pdf>
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import cfg from '../lib/config.cjs'

const [ticket, envName, runId, out] = process.argv.slice(2)
if (!out) { console.error('usage: report-pdf.mjs <ticket> <env> <run id> <out.pdf>'); process.exit(2) }
const html = path.join(cfg.runDir(ticket, cfg.envConfig(envName), runId), 'devices.html')
if (!fs.existsSync(html)) { console.error(`No devices.html at ${html} -- build the device report first.`); process.exit(1) }

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.emulateMedia({ media: 'print', colorScheme: 'light' })
  await page.goto(pathToFileURL(html).toString(), { waitUntil: 'load' })
  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `<div style="font-size:8px;color:#64748b;width:100%;padding:0 12mm;display:flex;justify-content:space-between"><span>${ticket} · ${envName} · run ${runId}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
  })
  console.log(`PDF -> ${out}`)
} finally {
  await browser.close()
}
