import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LLMProvider } from '../../providers/types'
import { renderSceneHtml } from '../../appRecon/scenes'
import { fontCss, gsapJs, introPage, lintIntro, previewPage, type Code, type Preview } from '../../introBg/kit'

// the page harness, the code rules and the browser checks are shared with the intro-background director
export { introPage, lintIntro }

/**
 * The intro director: the very opening of a marketing film is designed and
 * coded by the AI, never a template. One agent run:
 *
 *   1. plan + write — the model picks a concept for THIS business and this
 *      hook, writes the opening as a self-contained page (HTML + CSS + SVG +
 *      JS, GSAP available) and may ask for one AI backdrop picture;
 *   2. check — the code is linted (deterministic, offline, seekable), loaded
 *      in a real browser, stepped to four moments; errors, blank or frozen
 *      frames and text that runs off the frame are found by measuring;
 *   3. look — the model is shown those frames and scores them like a
 *      motion designer would;
 *   4. fix — what failed goes back to the model with its own code, up to
 *      three rounds; then the best page is rendered frame by frame.
 *
 * Only when every round fails (or there is no writer at all) does the caller
 * fall back to the drawn template, and it says so in the film's notes.
 */

export interface IntroBrief {
  /** the thumb-stopping opening words (shown big) */
  hook: string
  /** the trouble the film opens on (2 to 4 words) */
  headline: string
  /** the spoken line over the opening (for meaning and pace, not shown whole) */
  line: string
  business: string
  about: string
  /** hex without '#' */
  accent?: string
  backdrop?: [string, string]
  colors: string[]
  /** the look the person asked for (cinematic, playful, minimal…), if any */
  style: string | null
  tone?: string
}

export interface IntroInput {
  chat: LLMProvider
  brief: IntroBrief
  size: { width: number; height: number }
  durationSec: number
  dir: string
  /** one AI picture the director may ask for as its backdrop; absent = code only */
  still?: (prompt: string) => Promise<string | null>
  /** the business's logo (PNG) the code may place */
  logo?: string
  say?: (m: string) => void
  signal?: AbortSignal
  /** at most this many write → check rounds (default 3) */
  rounds?: number
}

export interface IntroResult {
  file: string | null
  durationSec: number
  rounds: number
  concept?: string
  /** the AI picture the code animates, if one was made */
  picture?: string
  score?: number
  why?: string
}

interface Draft extends Code {
  concept: string
  picture: string
}

const SYSTEM = `You are a senior motion designer and creative coder. You design and code the first seconds of a short marketing film for a real business: a premium, original title sequence that stops a thumb mid-scroll. It is NOT a template: the concept, layout, typography and motion come from this business, its product and this hook.

You write one self-contained web page that is rendered frame by frame to video:
- html: markup placed inside <div id="stage"> (the frame, W×H pixels, position:relative, overflow hidden). Use real HTML or SVG <text> for all words.
- css: styles. No CSS animations or transitions.
- js: must set window.__seek = function (t) { ... } that puts the page in its exact state at t seconds (0 ≤ t ≤ DURATION). It is called for every frame, in any order, so it must be a pure function of t. GSAP 3 is loaded (window.gsap): a timeline made with {paused:true} and moved with tl.seek(t) / tl.progress() is fine. No requestAnimationFrame, timers, Date, fetch or external files. Math.random is seeded (deterministic).
- Globals: W, H, DURATION (seconds), ASSETS.picture (data URL of your backdrop picture, or '' when none), ASSETS.logo (data URL of the business logo PNG, or '').
- Fonts available: 'Inter' (100-900), 'Archivo Black', 'Barlow Condensed' (800), 'Instrument Serif' (italic), 'Playfair Display' (700), 'Space Grotesk' (700), 'Nunito' (800), plus system sans-serif.

Craft rules:
- The hook is the star: big, bold, perfectly readable, revealed with motion (word by word, masks, kinetic type), on screen by 0.6 s and readable for at least 1.5 s. Then the trouble (headline) can take over. Spell every word exactly as given.
- Everything moves the whole time (slow camera push, parallax, light sweeps, shapes, particles); no frozen frames, no flash cuts to black.
- Layered depth: a rich backdrop (the picture with a slow move and a colour grade, or drawn gradients/shapes/SVG), mid shapes, then type. Brand colours lead.
- Keep the bottom 20% of the frame free of text (captions sit there) and keep 6% margins; nothing may be cut off at the frame edge. Size type to the frame (tall frames need narrower lines).
- Performance: it renders on a CPU. No full-frame filters (blur, backdrop-filter, mix-blend-mode) on large areas, under ~150 animated elements.

picture: on the first draft you may ask for ONE AI backdrop photograph (a vivid concrete scene that sets up the trouble: real people, places, objects; no text, no logos in it) — write its prompt, or '' to use drawn graphics only. It arrives as ASSETS.picture. Never rely on it existing: handle ''.

Answer only the JSON asked for.`

const SCHEMA = {
  type: 'object',
  properties: {
    concept: { type: 'string', description: 'one or two sentences: the idea and the motion' },
    picture: { type: 'string', description: "the backdrop photo prompt, or ''" },
    html: { type: 'string' },
    css: { type: 'string' },
    js: { type: 'string' }
  },
  required: ['concept', 'picture', 'html', 'css', 'js'],
  additionalProperties: false
}

function briefText(b: IntroBrief, size: { width: number; height: number }, durationSec: number): string {
  return [
    `Business: ${b.business}. ${b.about.slice(0, 500)}`,
    `Hook (show these exact words): "${b.hook}"`,
    `The trouble (headline, may follow the hook): "${b.headline}"`,
    `Spoken over the opening: "${b.line}"`,
    `Frame: ${size.width}×${size.height} (${size.height > size.width ? 'tall, for phones' : size.width === size.height ? 'square' : 'wide'}), ${durationSec.toFixed(1)} s.`,
    `Brand colours: ${[b.accent ? `#${b.accent}` : '', ...b.colors].filter(Boolean).slice(0, 5).join(', ') || 'none given: choose a premium palette that fits'}${b.backdrop ? `; backdrop ${b.backdrop.join(' → ')}` : ''}.`,
    b.style ? `Look asked for: ${b.style}.` : '',
    b.tone ? `Tone: ${b.tone}.` : ''
  ].filter(Boolean).join('\n')
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', description: '1 to 10' },
    hookReadable: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } }
  },
  required: ['score', 'hookReadable', 'issues'],
  additionalProperties: false
}

/** the director looks at its own frames like a motion designer would */
async function lookAt(chat: LLMProvider, frames: string[], b: IntroBrief): Promise<{ score: number; hookReadable: boolean; issues: string[] } | null> {
  if (chat.supportsVision?.() === false || !frames.length) return null
  try {
    const sharp = (await import('sharp')).default
    const images = await Promise.all(frames.map(async (f) => ({ mimeType: 'image/jpeg', base64: (await sharp(readFileSync(f)).resize({ width: 640, height: 640, fit: 'inside' }).jpeg({ quality: 80 }).toBuffer()).toString('base64') })))
    const r = await chat.generateJSON<{ score: number; hookReadable: boolean; issues: string[] }>({
      system:
        'You are a strict creative director reviewing four frames (in time order) of the opening seconds of a marketing film. Score 1-10 for premium, original, on-brand motion design a business would pay for: readable bold typography, clear hierarchy, rich layered backdrop, nothing cut off or overlapping, no empty or broken frames, no misspelled words. hookReadable = the hook words can be read clearly in at least one frame. List concrete, fixable issues (what and where).',
      prompt: `Hook: "${b.hook}". Trouble: "${b.headline}". Business: ${b.business}.`,
      jsonSchema: REVIEW_SCHEMA,
      schemaName: 'IntroReview',
      images,
      temperature: 0.2,
      maxTokens: 600
    })
    return { score: Number(r.score) || 0, hookReadable: r.hookReadable !== false, issues: (r.issues ?? []).slice(0, 6) }
  } catch {
    return null
  }
}

export async function directIntro(inp: IntroInput): Promise<IntroResult> {
  const say = inp.say ?? (() => undefined)
  const rounds = Math.max(1, inp.rounds ?? 3)
  mkdirSync(inp.dir, { recursive: true })
  const embed = { fonts: fontCss(), gsap: gsapJs() }
  let picture: string | undefined
  let pictureAsked = false
  let best: { draft: Draft; score: number; page: string } | null = null
  let feedback = ''
  let last: Draft | null = null
  let why = ''
  let used = 0
  for (let round = 1; round <= rounds; round++) {
    if (inp.signal?.aborted) throw new Error('cancelled')
    used = round
    let draft: Draft
    try {
      draft = await inp.chat.generateJSON<Draft>({
        system: SYSTEM,
        prompt:
          briefText(inp.brief, inp.size, inp.durationSec) +
          (last ? `\n\nYour previous draft:\nconcept: ${last.concept}\nhtml:\n${last.html}\ncss:\n${last.css}\njs:\n${last.js}\n\nFix these problems (keep what works, make it better):\n${feedback}${picture ? '\nYour backdrop picture exists (ASSETS.picture); keep picture the same.' : pictureAsked ? '\nThe backdrop picture could not be made: ASSETS.picture is empty, so design without it.' : ''}` : ''),
        jsonSchema: SCHEMA,
        schemaName: 'IntroCode',
        temperature: last ? 0.5 : 0.9,
        maxTokens: 16000
      })
    } catch (err) {
      why = `the director could not write the code (${String((err as Error)?.message ?? err).slice(0, 100)})`
      say(`  intro round ${round}: ${why}`)
      continue
    }
    draft = { concept: String(draft.concept ?? ''), picture: String(draft.picture ?? ''), html: String(draft.html ?? ''), css: String(draft.css ?? ''), js: String(draft.js ?? '') }
    last = draft
    say(`  intro round ${round}: "${draft.concept.slice(0, 110)}"`)
    // the backdrop picture, asked for once
    if (!pictureAsked && draft.picture.trim() && inp.still) {
      pictureAsked = true
      try {
        picture = (await inp.still(draft.picture.trim())) ?? undefined
        say(picture ? '  intro: the AI backdrop picture was made' : '  intro: the backdrop picture did not pass its check; code only')
      } catch (err) {
        say(`  intro: the backdrop picture could not be made (${String((err as Error)?.message ?? err).slice(0, 80)})`)
      }
    }
    const lint = lintIntro(draft)
    if (lint.length) {
      feedback = lint.map((x) => `- ${x}`).join('\n')
      why = `its code broke the rules (${lint[0]})`
      say(`  intro round ${round}: ${lint.length} rule problem(s): ${lint[0].slice(0, 90)}`)
      continue
    }
    const page = introPage(draft, inp.size, inp.durationSec, { picture, logo: inp.logo }, embed)
    let pv: Preview
    try {
      pv = await previewPage(page, inp.size, inp.durationSec, inp.dir, round, { hook: inp.brief.hook })
    } catch (err) {
      pv = { errors: [`the page could not be loaded: ${String((err as Error)?.message ?? err).slice(0, 150)}`], frames: [], measured: [] }
    }
    const hard = [...pv.errors.map((e) => `Script error: ${e}`), ...pv.measured]
    const look = pv.frames.length >= 3 ? await lookAt(inp.chat, pv.frames, inp.brief) : null
    const score = look ? look.score : hard.length ? 0 : 7
    const ok = !hard.length && (!look || (look.score >= 7 && look.hookReadable))
    say(`  intro round ${round}: ${hard.length} measured problem(s)${hard.length ? ` (${hard[0].slice(0, 90)})` : ''}${look ? `, the director scores it ${look.score}/10` : ''}`)
    // a draft that loads and draws is kept as a candidate; each measured problem costs it 3 points
    const rank = score - 3 * pv.measured.length
    if (!pv.errors.length && pv.frames.length >= 3 && rank >= 4 && (!best || rank > best.score)) best = { draft, score: rank, page }
    if (ok) break
    feedback = [...hard, ...(look?.issues ?? []), ...(look && !look.hookReadable ? ['The hook cannot be read clearly: make it bigger, higher contrast, on screen longer.'] : [])].map((x) => `- ${x}`).join('\n')
    why = hard[0] ?? look?.issues[0] ?? 'it scored below 7/10'
  }
  if (!best) return { file: null, durationSec: inp.durationSec, rounds: used, why: why || 'no draft could be rendered' }
  writeFileSync(join(inp.dir, 'intro.html'), best.page)
  const out = await renderSceneHtml(best.page, inp.size, inp.durationSec, join(inp.dir, 'intro.mp4'))
  return { file: out.file, durationSec: out.durationSec, rounds: used, concept: best.draft.concept, ...(picture ? { picture } : {}), score: best.score }
}
