/** Inspect the existing application URL in an isolated verification browser. */
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' })
  try { await page.getByRole('button').first().waitFor({ timeout: 20000 }) }
  catch (error) { errors.push(error.message) }
  await mkdir('local-plugins/session-fast/evidence', { recursive: true })
  await page.screenshot({ path: 'local-plugins/session-fast/evidence/initial.png' })
  console.log(JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText()).slice(0, 500), buttons: await page.getByRole('button').allTextContents(), labels: await page.locator('[aria-label]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), errors }, null, 2))
} finally { await browser.close() }
