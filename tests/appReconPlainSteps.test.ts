import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser } from 'puppeteer-core'
import { launch } from '../src/main/appRecon/browser'
import { findElement } from '../src/main/appRecon/resolve'
import { readBriefByRules, accountFor } from '../src/main/appRecon/agent/brief'

// a launch-film brief written as plain sentences: only clicks, with what should happen in between
const BRIEF = `let's divide the scale into two in following steps:
from the bottom of the page, click the cut icon. the modal appears.
from the modal, click 2.
from the modal, click green button with tick mark. the modal closes and confirmation appears.
click the green button with tick mark.
and the scale divides into two.`

describe('steps written as plain sentences (no list, no goal)', () => {
  it('a launch film carries every click as one script, and nothing is "could not place"', () => {
    const plan = accountFor(BRIEF, readBriefByRules({ context: BRIEF, mode: 'launch', launch: { feature: 'homeschooling', tagline: 'Simple. Fast. Safe.' } } as never))
    expect(plan.unplaced).toEqual([])
    const page = plan.segments.find((s) => s.kind === 'page')
    expect(page && page.kind === 'page' && page.how).toBe('script')
    expect(page && page.kind === 'page' ? page.actions : []).toEqual([
      'from the bottom of the page, click the cut icon',
      'from the modal, click 2',
      'from the modal, click green button with tick mark',
      'click the green button with tick mark'
    ])
    // the outcomes in between are part of the script, not left out
    expect(page?.said).toContain('the modal appears')
    expect(page?.said).toContain('the scale divides into two')
    // what was understood is the steps, not the launch tagline
    expect(plan.goal).not.toBe('Simple. Fast. Safe.')
  })

  it('a walkthrough reads the same brief the same way', () => {
    const plan = accountFor(BRIEF, readBriefByRules({ context: BRIEF, mode: 'walkthrough' } as never))
    expect(plan.unplaced).toEqual([])
    const page = plan.segments.find((s) => s.kind === 'page')
    expect(page && page.kind === 'page' ? page.actions?.length : 0).toBe(4)
  })

  it('a single plain-sentence click with nothing else is not turned into a script on its own', () => {
    const plan = readBriefByRules({ context: 'Make a short launch film. Click the pricing tab.', mode: 'launch', launch: { feature: 'x', tagline: 'Fast.' } } as never)
    expect(plan.segments.filter((s) => s.kind === 'page' && s.how === 'script').length).toBe(0)
  })
})

describe('a symbol described in words', () => {
  let browser: Browser
  let dir: string
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vg-sym-'))
    browser = await launch({ userDataDir: dir, width: 900, height: 640, scale: 1 })
  }, 90000)
  afterAll(async () => {
    await Promise.race([browser?.close().catch(() => undefined), new Promise((r) => setTimeout(r, 20000))])
    browser?.process()?.kill()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 120000)

  it('"green button with tick mark" is the ✓ key, "the cross" is ✕, "backspace" is ⌫', async () => {
    const page = await browser.newPage()
    await page.setContent(`<body style="font:20px sans-serif">
      <div role="dialog" aria-modal="true" style="position:fixed;left:200px;top:100px;padding:20px;background:#fff;border:1px solid #999">
        <div>Cut into how many parts?</div>
        <button id="k1">1</button><button id="k2">2</button><button id="bs">⌫</button>
        <button id="ok" style="background:#22a05a;color:#fff;width:200px">✓</button>
        <button id="x" style="background:#e04040;color:#fff">✗</button>
      </div></body>`)
    const id = async (target: string): Promise<string | null> => {
      const r = await findElement(page, { target, kind: 'click' }, 1500)
      if (!r.found) return null
      return page.$eval(r.found.selector, (el) => el.id)
    }
    expect(await id('green button with tick mark')).toBe('ok')
    expect(await id('the tick')).toBe('ok')
    expect(await id('check mark')).toBe('ok')
    expect(await id('the cross')).toBe('x')
    expect(await id('backspace')).toBe('bs')
    expect(await id('2')).toBe('k2')
    await page.close()
  }, 60000)
})
