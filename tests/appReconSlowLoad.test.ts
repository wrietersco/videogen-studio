import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome, launch } from '../src/main/appRecon/browser'
import { openPage } from '../src/main/appRecon/explore'

/** a real page whose 'load' event never fires because one picture never arrives */
describe.skipIf(!findChrome())('opening a page whose load event never fires', () => {
  let server: Server
  let url = ''
  let dir = ''
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/hang.png') return // never answers
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><h1>Dashboard</h1><p>The app is fully usable and shows plenty of text on screen.</p><img src="/hang.png"></body></html>')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
    dir = mkdtempSync(join(tmpdir(), 'vg-slow-'))
  })
  afterAll(() => {
    server.closeAllConnections?.()
    server.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  })

  it('carries on with the usable page instead of failing the whole video', async () => {
    const browser = await launch({ userDataDir: join(dir, 'p'), headless: true })
    try {
      const page = await browser.newPage()
      const t0 = Date.now()
      await openPage(page, url, 4000)
      expect(Date.now() - t0).toBeLessThan(15000)
      expect(await page.evaluate(() => document.body.innerText)).toContain('Dashboard')
    } finally {
      await browser.close()
    }
  }, 60000)
})
