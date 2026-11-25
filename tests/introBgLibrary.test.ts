import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aspectOf, IntroBackgroundLibrary, isUnchangedCopy, keywordsOf, tokens, type BackgroundMeta } from '../src/main/introBg/library'
import type { Code } from '../src/main/introBg/kit'

/**
 * The intro-background library: backgrounds the AI designed are kept on disk
 * with detailed notes; a later film on a similar topic finds the close ones
 * (as a starting point to adapt), and a stored background handed back
 * unchanged is recognised as a template drop-in.
 */

const root = mkdtempSync(join(tmpdir(), 'vg-introbg-lib-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))

const code: Code = {
  html: '<canvas id="c" width="1080" height="1920"></canvas>',
  css: '#c{position:absolute;left:0;top:0}',
  js: Array.from({ length: 24 }, (_, i) => `var line${i} = ${i} * 3; // arc ${i}`).join('\n') + '\nwindow.__seek=function(t){};'
}

const meta = (over: Partial<Omit<BackgroundMeta, 'id' | 'createdAt'>> = {}): Omit<BackgroundMeta, 'id' | 'createdAt'> => ({
  topic: 'A web tool that compares words in the Quran: ratios and places of two words on an even-odd circle',
  keywords: ['quran', 'arabic', 'calligraphy', 'balance', 'verse', 'ratio'],
  mood: 'contemplative',
  palette: ['#0f1a09', '#6aa629'],
  concept: 'Arabic calligraphic strokes draw themselves while a balance beam levels.',
  model: 'test-model',
  score: 8,
  aspects: ['tall'],
  size: { width: 1080, height: 1920 },
  durationSec: 6,
  kind: 'title',
  usesThree: false,
  ...over
})

describe('keywords', () => {
  it('drops filler and keeps the subject words', () => {
    expect(tokens('The app is for tracking your workouts and heart rates')).toEqual(expect.arrayContaining(['track', 'workout', 'heart', 'rate']))
    expect(tokens('the and of a')).toEqual([])
    expect(keywordsOf('quran quran balance verse ratio quran verse', 3)).toEqual(['quran', 'verse', 'balance'])
  })
  it('knows the frame shape', () => {
    expect(aspectOf({ width: 1080, height: 1920 })).toBe('tall')
    expect(aspectOf({ width: 1920, height: 1080 })).toBe('wide')
    expect(aspectOf({ width: 1080, height: 1080 })).toBe('square')
  })
})

describe('the library on disk', () => {
  it('saves a background with its page, source, notes and index, and reads it back', () => {
    const lib = new IntroBackgroundLibrary(join(root, 'a'))
    const preview = join(root, 'frame.jpg')
    writeFileSync(preview, 'jpg')
    const saved = lib.save(meta(), code, '<html>playable</html>', preview)
    const dir = join(root, 'a', saved.id)
    expect(existsSync(join(dir, 'index.html'))).toBe(true)
    expect(existsSync(join(dir, 'preview.jpg'))).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as BackgroundMeta
    expect(onDisk).toMatchObject({ topic: expect.stringContaining('Quran'), mood: 'contemplative', model: 'test-model', score: 8, aspects: ['tall'], kind: 'title' })
    expect(onDisk.palette).toEqual(['#0f1a09', '#6aa629'])
    expect(onDisk.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(JSON.parse(readFileSync(join(root, 'a', 'index.json'), 'utf8')).entries).toHaveLength(1)
    expect(lib.get(saved.id)?.code).toEqual(code)
    expect(lib.list().map((e) => e.id)).toEqual([saved.id])
  })

  it('stores the same code once and rebuilds a lost index from the folders', () => {
    const lib = new IntroBackgroundLibrary(join(root, 'b'))
    const one = lib.save(meta(), code, 'x')
    const again = lib.save(meta({ score: 9 }), code, 'x')
    expect(again.id).toBe(one.id)
    expect(lib.list()).toHaveLength(1)
    rmSync(join(root, 'b', 'index.json'))
    expect(lib.list().map((e) => e.id)).toEqual([one.id])
  })

  it('finds close matches by topic, not unrelated ones', () => {
    const lib = new IntroBackgroundLibrary(join(root, 'c'))
    const quran = lib.save(meta(), code, 'x')
    lib.save(meta({ topic: 'A bakery with sourdough and rising dough, warm ovens', keywords: ['bakery', 'bread', 'dough', 'oven'], mood: 'warm' }), { ...code, js: code.js + '\n//bakery' }, 'x')
    const close = lib.lookup({ text: 'Compare words of the Quran by ratio and verse place', aspect: 'tall' })
    expect(close.map((m) => m.meta.id)).toEqual([quran.id])
    expect(lib.lookup({ text: 'Fitness tracking app with heart rate rings' })).toEqual([])
    expect(lib.lookup({ text: '' })).toEqual([])
    // a closing scene is not offered for a title
    expect(lib.lookup({ text: 'Quran words ratio' }, { kind: 'outro' })).toEqual([])
  })

  it('counts how many films started from an entry', () => {
    const lib = new IntroBackgroundLibrary(join(root, 'd'))
    const e = lib.save(meta(), code, 'x')
    lib.markAdapted(e.id)
    lib.markAdapted(e.id)
    expect(lib.list()[0].adaptedCount).toBe(2)
    lib.remove(e.id)
    expect(lib.list()).toEqual([])
    expect(lib.get(e.id)).toBeNull()
  })

  it('refuses ids that could leave the folder', () => {
    const lib = new IntroBackgroundLibrary(join(root, 'e'))
    expect(lib.get('../../etc')).toBeNull()
  })
})

describe('a stored background is never dropped in unchanged', () => {
  it('recognises the same code, even re-spaced', () => {
    expect(isUnchangedCopy(code, code)).toBe(true)
    expect(isUnchangedCopy({ ...code, js: code.js.replace(/\n/g, '\n\n  ') }, code)).toBe(true)
  })
  it('recognises a copy with only a colour or two changed', () => {
    expect(isUnchangedCopy({ ...code, css: '#c{position:absolute;left:0;top:0;background:#123}' }, code)).toBe(true)
  })
  it('accepts a real redesign', () => {
    const redesign: Code = {
      html: '<svg id="s"></svg>',
      css: '#s{width:100%}',
      js: Array.from({ length: 24 }, (_, i) => `var stroke${i} = Math.sin(${i}); // calligraphy ${i}`).join('\n') + '\nwindow.__seek=function(t){ draw(t) };'
    }
    expect(isUnchangedCopy(redesign, code)).toBe(false)
  })
})
