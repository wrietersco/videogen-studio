import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome } from '../src/main/appRecon/browser'
import type { LLMProvider } from '../src/main/providers/types'
import { directIntro, introPage, lintIntro } from '../src/main/marketing/agent/intro'
import { temperatureFor, withThinkingRoom } from '../src/main/providers/gemini'
import { priceUsage } from '../src/shared/pricing'

/**
 * The intro director: the opening of a marketing film is code the AI writes,
 * checked in a real browser and by the AI's own eyes, fixed, then rendered.
 * A scripted stand-in plays the model, so nothing is paid for.
 */

const root = mkdtempSync(join(tmpdir(), 'vg-intro-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))

const good = {
  concept: 'Words drop in one by one over a slow drifting gradient with a light sweep.',
  picture: '',
  html: '<div class="bg"></div><div class="sweep"></div><h1 class="hook"><span>Still</span> <span>watering</span> <span>every</span> <span>weekend?</span></h1><h2 class="trouble">The garden wins</h2>',
  css: '.bg{position:absolute;inset:-10%;background:radial-gradient(circle at 30% 40%,#2f9e44,#0a120a)}.sweep{position:absolute;top:0;bottom:0;width:30%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.18),transparent)}.hook{position:absolute;left:8%;right:8%;top:22%;margin:0;font:400 110px "Archivo Black";color:#fff}.hook span{display:inline-block}.trouble{position:absolute;left:8%;top:62%;margin:0;font:800 70px "Barlow Condensed";color:#ffd43b}',
  js: `var tl=gsap.timeline({paused:true});
tl.fromTo('.bg',{scale:1},{scale:1.15,duration:DURATION,ease:'none'},0);
tl.fromTo('.sweep',{x:-0.4*W},{x:1.2*W,duration:DURATION,ease:'none'},0);
tl.fromTo('.hook span',{y:80,opacity:0},{y:0,opacity:1,stagger:0.12,duration:0.4,immediateRender:false},0.1);
tl.fromTo('.trouble',{opacity:0,y:40},{opacity:1,y:0,duration:0.5,immediateRender:false},1.6);
window.__seek=function(t){tl.seek(t,false)};`
}

describe('intro code rules', () => {
  it('accepts a seekable, offline page', () => {
    expect(lintIntro(good)).toEqual([])
  })
  it('rejects clocks, timers, network and CSS animation', () => {
    expect(lintIntro({ ...good, js: 'requestAnimationFrame(f)' }).join(' ')).toMatch(/__seek[\s\S]*requestAnimationFrame/)
    expect(lintIntro({ ...good, js: good.js + 'fetch("x")' }).join(' ')).toMatch(/network/)
    expect(lintIntro({ ...good, html: '<img src="https://x.test/a.png">' }).join(' ')).toMatch(/external/)
    expect(lintIntro({ ...good, css: '.a{animation:spin 1s}' }).join(' ')).toMatch(/CSS animations/)
  })
  it('puts the code in a harness with the frame size, seeded randomness and no early </script>', () => {
    const page = introPage({ ...good, js: good.js + '//</script>' }, { width: 1080, height: 1920 }, 4, {}, { fonts: '', gsap: '' })
    expect(page).toContain('window.W=1080;window.H=1920;window.DURATION=4.000')
    expect(page).toContain('Math.random=function')
    expect(page).not.toMatch(/\/\/<\/script>/)
  })
})

describe('Gemini 4 Neon', () => {
  it('is priced and gets thinking room', () => {
    expect(priceUsage('gemini-4-neon', { inputTokens: 1_000_000, outputTokens: 1_000_000 }).usd).toBeCloseTo(18, 5)
    expect(withThinkingRoom('gemini-4-neon', 4096)).toBeGreaterThan(20000)
    expect(withThinkingRoom('gemini-3.8-flash', 4096)).toBe(4096)
    // low temperatures make Gemini 4 loop: it keeps its default
    expect(temperatureFor('gemini-4-neon', 0.3)).toBeUndefined()
    expect(temperatureFor('gemini-3.8-flash', 0.3)).toBe(0.3)
  })
})

describe.skipIf(!findChrome())('the intro director', () => {
  it('writes, checks, fixes its own mistake, and renders the opening', async () => {
    const calls: string[] = []
    let rounds = 0
    const chat = {
      generateJSON: async (req: { schemaName?: string; prompt: string; images?: unknown[] }) => {
        calls.push(req.schemaName ?? '')
        if (req.schemaName === 'IntroCode') {
          rounds++
          // the first draft breaks: a script error. The second answers the feedback.
          if (rounds === 1) return { ...good, js: 'window.__seek=function(t){ undefinedThing.go(t) }' }
          expect(req.prompt).toMatch(/Script error/)
          return good
        }
        if (req.schemaName === 'IntroReview') {
          expect(req.images?.length).toBe(4)
          return { score: 8, hookReadable: true, issues: [] }
        }
        throw new Error(`unexpected ${req.schemaName}`)
      }
    } as unknown as LLMProvider
    const r = await directIntro({
      chat,
      brief: { hook: 'Still watering every weekend?', headline: 'The garden wins', line: 'Every weekend ends in watering cans.', business: 'GreenLeaf', about: 'Gardens', accent: '2f9e44', colors: ['#1a5c1a'], style: null },
      size: { width: 1280, height: 720 },
      durationSec: 3,
      dir: join(root, 'ok'),
      say: (m) => console.log(m)
    })
    expect(r.file && existsSync(r.file)).toBe(true)
    expect(r.rounds).toBe(2)
    expect(r.score).toBe(8)
    expect(calls).toEqual(['IntroCode', 'IntroCode', 'IntroReview'])
  }, 180000)

  it('says why when every round fails, so the caller can fall back honestly', async () => {
    const chat = { generateJSON: async () => ({ ...good, js: 'var x = 1' }) } as unknown as LLMProvider
    const r = await directIntro({
      chat,
      brief: { hook: 'Still watering every weekend?', headline: 'The garden wins', line: 'x', business: 'GreenLeaf', about: '', colors: [], style: null },
      size: { width: 320, height: 180 },
      durationSec: 2,
      dir: join(root, 'bad'),
      rounds: 2
    })
    expect(r.file).toBeNull()
    expect(r.why).toMatch(/__seek/)
  }, 60000)
})

describe('the trouble headline', () => {
  it('keeps a non-software trouble the writer chose, but never the name or the answer', async () => {
    const { marketTitleOk } = await import('../src/main/marketing/film')
    expect(marketTitleOk('Dry, bland cookies', 'Golden crispy edges and a soft center', 'Oye Cookie')).toBe(true)
    expect(marketTitleOk('Oye Cookie fixes it', 'x', 'Oye Cookie')).toBe(false)
    expect(marketTitleOk('Golden crispy edges', 'Golden crispy edges and a soft center', 'Oye Cookie')).toBe(false)
  })
})
