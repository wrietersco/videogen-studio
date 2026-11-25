import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LLMProvider } from '../providers/types'
import { sceneHtml } from '../appRecon/scenes'
import { gsapJs, introPage, lintIntro, previewPage, type Code, type SceneBackground } from './kit'
import { aspectOf, isUnchangedCopy, keywordsOf, type BackgroundMeta, type IntroBackgroundLibrary, type Match } from './library'

/**
 * The intro-background director. The title scene and the closing scene of a
 * film each sit on a background that the AI designs for THIS film: the writer
 * model reads the topic, the product, the script, the brand and what the
 * product's pages look like, picks a visual idea that belongs to that subject
 * (never a stock motif), and writes it as HTML/CSS/SVG/canvas/JS (three.js
 * when it helps). The code goes through the same agent loop as the Market
 * intro: lint, load in a real browser at four moments, measure (errors, flat or
 * frozen frames, words off the frame), the model scores its own frames with the
 * title text laid over them, up to three fix rounds. A background that passes
 * is kept in the library for later films on similar topics, where it can be
 * adapted (never reused as it stands). Only when every round fails does the
 * caller fall back to the drawn motif, and the film's notes say so.
 */

export interface BackgroundBrief {
  kind: 'title' | 'outro'
  /** what the film is about, in a sentence or two */
  topic: string
  /** the product or business name */
  product?: string
  /** more about it: the description, the page headings, the context the person wrote */
  about?: string
  /** the film's script (what the narrator says), for the story and the mood */
  narration?: string
  /** the words that will be laid over the background (so the art leaves them room) */
  pill?: string
  headline: string
  sub?: string
  hasLogo?: boolean
  /** hex without '#' */
  accent?: string
  backdrop?: [string, string]
  colors?: string[]
  /** the look the person asked for, if any */
  style?: string | null
  mood?: string
}

export interface BackgroundInput {
  chat: LLMProvider
  brief: BackgroundBrief
  size: { width: number; height: number }
  durationSec: number
  /** scratch folder for this run's frames */
  dir: string
  library?: IntroBackgroundLibrary | null
  /** screenshots of the product's pages (paths): the writer looks at them for the domain and the look, never copies a UI */
  pictures?: string[]
  /** the title scene's background that a closing scene belongs with */
  family?: { code: Code; concept: string; id?: string }
  logo?: string
  /** a per-call model override and the name to record in the library */
  model?: string
  modelName?: string
  say?: (m: string) => void
  signal?: AbortSignal
  /** at most this many write → check rounds (default 3) */
  rounds?: number
}

export interface BackgroundResult {
  background: SceneBackground | null
  concept?: string
  score?: number
  rounds: number
  why?: string
  /** the stored background this one started from, if the library had a close match */
  adaptedFrom?: { id: string; topic: string }
  /** its entry in the library, when it was good enough to keep */
  savedId?: string
}

interface Draft extends Code {
  ideas?: string[]
  concept: string
  keywords: string[]
  mood: string
  palette: string[]
}

const SYSTEM = `You are a senior motion designer and creative coder. You design the full-frame BACKGROUND of one scene of a short film (its title scene, or its closing scene): original generative art made for THIS film's subject. The film's title words, a small label and the logo are laid over it afterwards, so your art carries no words of its own.

What makes it right:
- It belongs to the subject. Before coding, ask what this subject's world looks like: its objects, shapes, writing systems, instruments, textures, places, rhythms, numbers. Build the art from those (the way a title designer would for a documentary on exactly this). Concrete examples of that thinking, NOT to be reused unless the subject is the same: a tool that compares words in a holy text -> slow Arabic calligraphic strokes drawing themselves, a balance beam tipping to level, a grid of verse cells lighting up as they are counted; a fitness tracker -> a heartbeat trace running into activity rings that close, track lanes and a sweeping split-time light; a bakery -> rising dough curves, steam, flour dust, a warm oven glow.
- It is NOT a stock backdrop. Never draw a field of glowing dots joined by lines (stars, nodes, constellations, networks, graphs), floating orbs, bokeh, generic particles, plain gradient blobs or a dot grid as the main idea, unless the subject is literally that. Decoration that could sit behind any film is a failure.
- It is premium and alive: layered depth (far, middle, near), a clear focal structure, slow confident camera-like motion, light that moves. Brand colours lead; a dark, rich base works best under white title text but you choose it for the subject.
- It leaves the middle of the frame calm for the title: keep the central band (about the middle 70% of the width and the middle 45% of the height) low in contrast and mostly darker than mid-grey so white 60-100 px bold text over it reads instantly. Put the detail, the focal art and the energy toward the edges and the top and bottom thirds, or let it sweep behind the text softly.
- No readable words, no logos, no UI mock-ups. Single decorative glyphs or letterforms of the subject's own script are welcome as art if they are big, partly abstract and quiet behind the text.
- It fills the whole frame from the first frame (no black bars, no empty frame at the start) and it is finished on its last frame: the scene may hold the last frame, so design the motion to arrive at a beautiful settled composition at t = DURATION.

How it is built: one self-contained web page rendered frame by frame to video.
- html: markup placed inside <div id="stage"> (the frame, W×H px, position:relative, overflow hidden).
- css: styles. No CSS animations or transitions.
- js: must set window.__seek = function (t) { ... } that puts the page in its exact state at t seconds (0 ≤ t ≤ DURATION). It is called for every frame, in any order, so it must be a pure function of t (nothing carried from the previous call). GSAP 3 is loaded (window.gsap): a timeline made with {paused:true} and moved with tl.seek(t) is fine. Canvas 2D (draw everything from scratch in __seek), inline SVG and CSS are all fine. No requestAnimationFrame, timers, Date, fetch, external files. Math.random is seeded (deterministic) but for stable shapes derive them from your own seeded generator once, outside __seek. Globals: W, H, DURATION (seconds, between 3 and 8: use u = t / DURATION for pacing), ASSETS.logo (data URL or '').
- three.js (r17x) is available offline but it is rasterised on a CPU and is VERY slow here (seconds per frame at film size), so a draft that is slow is rejected. Prefer canvas 2D and SVG, which are fast. Use three.js only for a tiny scene (a handful of simple meshes): start js with  import * as THREE from 'three'  and render with new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: false }), setPixelRatio(1), setSize(W/2, H/2) with the canvas scaled to W×H by CSS, appended to #stage, calling renderer.render inside __seek. No other import is allowed.
- Performance: it renders on a CPU, about 180 frames per scene, and each frame must draw in well under a second. No full-frame CSS filters (blur, backdrop-filter, mix-blend-mode) on large areas, under ~200 animated DOM elements; canvas draws can be rich but keep under a few thousand path segments per frame. Make the art clearly visible: shapes and lines at least ~25% brighter than the base, not near-black on black.
- Fonts: none needed. If you draw a glyph use font-family 'Segoe UI','Noto Sans Arabic','Noto Sans',serif.

First list three genuinely different ideas (ideas), then choose the one that is most specific to this subject and least like any other film's background (concept) and build that one.

Also return: keywords (6-12 lower-case words naming the subject and the visual motifs you used, for filing the background), mood (one or two words), palette (3-5 hex colours you used).

Answer only the JSON asked for.`

const SCHEMA = {
  type: 'object',
  properties: {
    ideas: { type: 'array', items: { type: 'string' }, description: 'three different candidate visual ideas, each built from the subject’s own objects, writing, shapes or rhythms (none a field of glowing dots)' },
    concept: { type: 'string', description: 'the idea you chose, in two or three sentences: what is drawn, why it belongs to this subject, and how it moves' },
    keywords: { type: 'array', items: { type: 'string' } },
    mood: { type: 'string' },
    palette: { type: 'array', items: { type: 'string' } },
    html: { type: 'string' },
    css: { type: 'string' },
    js: { type: 'string' }
  },
  required: ['ideas', 'concept', 'keywords', 'mood', 'palette', 'html', 'css', 'js'],
  additionalProperties: false
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', description: '1 to 10' },
    belongsToSubject: { type: 'boolean', description: 'the art is clearly made from this subject, not generic' },
    generic: { type: 'boolean', description: 'it is a stock backdrop (glowing dots and lines, orbs, particles, gradient blobs)' },
    titleReadable: { type: 'boolean', description: 'the white title text is easy to read over it' },
    issues: { type: 'array', items: { type: 'string' } }
  },
  required: ['score', 'belongsToSubject', 'generic', 'titleReadable', 'issues'],
  additionalProperties: false
}

/** a background scoring at least this is kept in the library for later films (the loop itself stops early at 7) */
const KEEP_SCORE = 6

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)

function briefText(b: BackgroundBrief, size: { width: number; height: number }, durationSec: number): string {
  const colours = [b.accent ? `#${b.accent.replace('#', '')}` : '', ...(b.backdrop ?? []), ...(b.colors ?? [])].filter(Boolean).slice(0, 6)
  return [
    `Scene: the ${b.kind === 'title' ? 'TITLE scene (the film opens on it)' : 'CLOSING scene (the film ends on it)'}.`,
    `Subject of the film: ${clip(b.topic, 600)}`,
    b.product ? `Product / business: ${b.product}.` : '',
    b.about ? `About it: ${clip(b.about, 1200)}` : '',
    b.narration ? `What the film says (the story and mood): ${clip(b.narration, 900)}` : '',
    `Words that will be laid over your art (leave them room, do not draw them): ${[b.pill ? `label "${b.pill}"` : '', `headline "${b.headline}"`, b.sub ? `sub-line "${b.sub}"` : '', b.hasLogo ? 'and the logo above them' : ''].filter(Boolean).join(', ')}.`,
    `Frame: ${size.width}×${size.height} (${size.height > size.width ? 'tall, for phones' : size.width === size.height ? 'square' : 'wide'}), ${durationSec.toFixed(1)} s.`,
    `Brand colours: ${colours.join(', ') || 'none given: choose a palette that belongs to the subject'}.`,
    b.style ? `Look asked for: ${b.style}.` : '',
    b.mood ? `Mood: ${b.mood}.` : ''
  ].filter(Boolean).join('\n')
}

/** a stored background offered as a starting point (never as the answer) */
function startingPoint(m: Match, code: Code): string {
  return `A stored background from an earlier film is a STARTING POINT you may adapt (it was made for: "${clip(m.meta.topic, 200)}"; idea: ${clip(m.meta.concept, 400)}). Do not hand it back unchanged and do not keep its subject: re-think the idea for THIS film's subject, change the motifs, composition and colours, and keep only what is useful as technique.\nIts code:\nhtml:\n${clip(code.html, 4000)}\ncss:\n${clip(code.css, 4000)}\njs:\n${clip(code.js, 9000)}`
}

function familyText(f: NonNullable<BackgroundInput['family']>): string {
  return `This is the closing scene: its background must BELONG with the title scene's background of the same film, so use the same family: the same palette, the same motif vocabulary and technique, but resolved and settled (an ending: calmer, the composition centred and complete, a gentle final glow), not a copy. Do not hand the title's code back unchanged.\nTitle scene's idea: ${clip(f.concept, 500)}\nTitle scene's code:\nhtml:\n${clip(f.code.html, 3500)}\ncss:\n${clip(f.code.css, 3500)}\njs:\n${clip(f.code.js, 8000)}`
}

interface Look {
  score: number
  titleReadable: boolean
  generic: boolean
  belongs: boolean
  issues: string[]
}

/** the director looks at its own frames, with the title text laid over, like a creative director would */
async function lookAt(chat: LLMProvider, frames: string[], b: BackgroundBrief, model?: string): Promise<Look | null> {
  if (chat.supportsVision?.() === false || !frames.length) return null
  try {
    const sharp = (await import('sharp')).default
    const images = await Promise.all(frames.map(async (f) => ({ mimeType: 'image/jpeg', base64: (await sharp(readFileSync(f)).resize({ width: 640, height: 640, fit: 'inside' }).jpeg({ quality: 80 }).toBuffer()).toString('base64') })))
    const r = await chat.generateJSON<{ score: number; belongsToSubject: boolean; generic: boolean; titleReadable: boolean; issues: string[] }>({
      system:
        'You are a strict creative director reviewing four frames, in time order, of a film\'s ' + (b.kind === 'title' ? 'title' : 'closing') + ' scene: AI-designed background art with the film\'s title text laid over it. Score 1-10 as a title designer a studio would pay for: the art is original and clearly made from THIS subject (not a stock backdrop of glowing dots and lines, orbs, particles or blobs), it is layered and rich and fills the whole frame, it moves, the white title text over it is easy to read (enough contrast, nothing busy behind the letters), nothing is cut off or broken, no frame is empty. belongsToSubject = a viewer who knows the subject would see it in the art. generic = it is a stock backdrop. titleReadable = the text reads easily in the later frames. List concrete, fixable issues (what and where).',
      prompt: `Subject: ${clip(b.topic, 400)}\nProduct: ${b.product ?? ''}\nTitle text: "${b.headline}"${b.sub ? ` / "${b.sub}"` : ''}`,
      jsonSchema: REVIEW_SCHEMA,
      schemaName: 'IntroBackgroundReview',
      images,
      temperature: 0.2,
      maxTokens: 700,
      ...(model ? { model } : {})
    })
    return { score: Number(r.score) || 0, titleReadable: r.titleReadable !== false, generic: r.generic === true, belongs: r.belongsToSubject !== false, issues: (r.issues ?? []).slice(0, 6) }
  } catch {
    return null
  }
}

async function pictureImages(paths: string[]): Promise<Array<{ mimeType: string; base64: string }>> {
  const out: Array<{ mimeType: string; base64: string }> = []
  try {
    const sharp = (await import('sharp')).default
    for (const p of paths.filter((x) => existsSync(x)).slice(0, 3)) {
      try {
        out.push({ mimeType: 'image/jpeg', base64: (await sharp(readFileSync(p)).resize({ width: 768, height: 768, fit: 'inside' }).jpeg({ quality: 75 }).toBuffer()).toString('base64') })
      } catch {
        // an unreadable picture is skipped
      }
    }
  } catch {
    // no image library: the writer works from the words
  }
  return out
}

/** a page that plays the background on its own (for opening the stored file in a browser) */
function playablePage(code: Code, size: { width: number; height: number }, durationSec: number): string {
  const page = introPage(code, size, durationSec, {}, { fonts: '', gsap: gsapJs() })
  const driver = `<script>(function(){var t0=null;function f(ts){if(t0===null)t0=ts;var t=((ts-t0)/1000)%(DURATION+1);if(window.__seek)window.__seek(Math.min(t,DURATION));requestAnimationFrame(f)}requestAnimationFrame(f)})();</script>`
  return page.replace(/<\/body>\s*<\/html>\s*$/, driver + '</body></html>')
}

export async function directBackground(inp: BackgroundInput): Promise<BackgroundResult> {
  const say = inp.say ?? (() => undefined)
  const rounds = Math.max(1, inp.rounds ?? 3)
  const b = inp.brief
  mkdirSync(inp.dir, { recursive: true })
  const aspect = aspectOf(inp.size)

  // close matches in the library: a starting point to adapt, never the answer
  const matches = inp.library && !inp.family ? inp.library.lookup({ text: `${b.topic} ${b.product ?? ''} ${b.about ?? ''}`, mood: b.mood, aspect }, { limit: 1, kind: b.kind }) : []
  const stored = matches.map((m) => ({ m, code: inp.library!.get(m.meta.id)?.code ?? null })).filter((x): x is { m: Match; code: Code } => !!x.code)
  if (stored.length) say(`  background: the library has a close match ("${clip(stored[0].m.meta.topic, 60)}"), used as a starting point to adapt`)
  const images = inp.pictures?.length && inp.chat.supportsVision?.() !== false ? await pictureImages(inp.pictures) : []

  let best: { draft: Draft; score: number; bgFrame: string | null; compositeFrame: string | null } | null = null
  let last: Draft | null = null
  let feedback = ''
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
          briefText(b, inp.size, inp.durationSec) +
          (images.length ? `\n\n${images.length} screenshot(s) of the product's own pages are attached: look at them for the domain, the content and the visual language of the product. Never copy its interface.` : '') +
          (inp.family ? `\n\n${familyText(inp.family)}` : '') +
          (!last && stored.length ? `\n\n${startingPoint(stored[0].m, stored[0].code)}` : '') +
          (last ? `\n\nYour previous draft:\nconcept: ${last.concept}\nhtml:\n${last.html}\ncss:\n${last.css}\njs:\n${last.js}\n\nFix these problems (keep what works, make it better and more specific to the subject):\n${feedback}` : ''),
        jsonSchema: SCHEMA,
        schemaName: 'IntroBackgroundCode',
        temperature: last ? 0.5 : 0.95,
        maxTokens: 16000,
        ...(images.length ? { images } : {}),
        ...(inp.model ? { model: inp.model } : {})
      })
    } catch (err) {
      why = `the director could not write the code (${String((err as Error)?.message ?? err).slice(0, 100)})`
      say(`  background round ${round}: ${why}`)
      continue
    }
    draft = {
      concept: String(draft.concept ?? ''),
      keywords: (Array.isArray(draft.keywords) ? draft.keywords : []).map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 14),
      mood: String(draft.mood ?? '').slice(0, 40),
      palette: (Array.isArray(draft.palette) ? draft.palette : []).map((c) => String(c).trim()).filter((c) => /^#[0-9a-f]{3,8}$/i.test(c)).slice(0, 6),
      html: String(draft.html ?? ''),
      css: String(draft.css ?? ''),
      js: String(draft.js ?? '')
    }
    last = draft
    try {
      writeFileSync(join(inp.dir, `draft-${round}.json`), JSON.stringify(draft, null, 2))
    } catch {
      // the notes are a convenience
    }
    say(`  background round ${round}: "${clip(draft.concept, 120)}"`)
    const problems = lintIntro(draft)
    // a stored background (or the title's, for the closing) handed back as it was is a template: refused
    for (const s of stored) if (isUnchangedCopy(draft, s.code)) problems.push('You handed back the stored background unchanged. Redesign it for THIS film: new idea, new motifs, new composition, new colours.')
    if (inp.family && isUnchangedCopy(draft, inp.family.code)) problems.push("You handed back the title scene's background unchanged. The closing scene's background must be the same family but settled and different.")
    if (problems.length) {
      feedback = problems.map((x) => `- ${x}`).join('\n')
      why = `its code broke the rules (${problems[0]})`
      say(`  background round ${round}: ${problems.length} rule problem(s): ${problems[0].slice(0, 90)}`)
      continue
    }
    // the art alone: errors, a flat or frozen picture
    let bgPv: Awaited<ReturnType<typeof previewPage>>
    try {
      bgPv = await previewPage(introPage(draft, inp.size, inp.durationSec, {}, { fonts: '', gsap: gsapJs() }), inp.size, inp.durationSec, inp.dir, round, { noText: true, prefix: 'bg-' })
    } catch (err) {
      bgPv = { errors: [`the page could not be loaded: ${String((err as Error)?.message ?? err).slice(0, 150)}`], frames: [], measured: [] }
    }
    // the art with the title text over it (what the viewer sees)
    let pv = { errors: [] as string[], frames: [] as string[], measured: [] as string[] }
    if (!bgPv.errors.length && bgPv.frames.length >= 3) {
      const T = Math.max(0.5, inp.durationSec)
      try {
        pv = await previewPage(
          sceneHtml({ kind: b.kind, pill: b.pill, headline: b.headline, sub: b.sub, accent: b.accent, logo: inp.logo, durationSec: T, size: inp.size, motif: 'cards', background: { code: draft } }),
          inp.size, T, inp.dir, round, { at: [T * 0.12, T * 0.4, T * 0.7, Math.max(0.3, T - 0.1)], hook: b.headline, textRoot: '#blk', prefix: 'title-' }
        )
      } catch (err) {
        pv = { errors: [`the scene could not be loaded: ${String((err as Error)?.message ?? err).slice(0, 150)}`], frames: [], measured: [] }
      }
    }
    const measured = [...bgPv.measured, ...pv.measured.filter((m) => !/Nothing moves/.test(m))]
    const hard = [...bgPv.errors, ...pv.errors].map((e) => `Script error: ${e}`).concat(measured)
    const look = !hard.length && pv.frames.length >= 3 ? await lookAt(inp.chat, pv.frames, b, inp.model) : null
    const score = look ? look.score : hard.length ? 0 : 7
    const ok = !hard.length && (!look || (look.score >= 7 && look.titleReadable && !look.generic && look.belongs))
    say(`  background round ${round}: ${hard.length} measured problem(s)${hard.length ? ` (${hard[0].slice(0, 90)})` : ''}${look ? `, the director scores it ${look.score}/10${look.generic ? ' (generic)' : ''}` : ''}`)
    const rank = score - 3 * measured.length - (look?.generic ? 3 : 0)
    if (!bgPv.errors.length && !pv.errors.length && bgPv.frames.length >= 3 && rank >= 4 && (!best || rank > best.score)) best = { draft, score: rank, bgFrame: bgPv.frames[bgPv.frames.length - 1] ?? null, compositeFrame: pv.frames[2] ?? null }
    if (ok) break
    feedback = [
      ...hard,
      ...(look?.issues ?? []),
      ...(look && !look.titleReadable ? ['The title text is hard to read over the art: calm the middle of the frame (lower contrast, darker) and keep the busy detail to the edges.'] : []),
      ...(look?.generic ? ['It reads as a stock backdrop. Replace the main idea with something that is visibly about this subject (its objects, its writing, its shapes).'] : []),
      ...(look && !look.belongs ? ['A viewer would not know what subject this is about. Make the subject visible in the art.'] : [])
    ].map((x) => `- ${x}`).join('\n')
    why = hard[0] ?? look?.issues[0] ?? 'it scored below 7/10'
  }
  if (!best) return { background: null, rounds: used, why: why || 'no draft could be rendered', ...(stored[0] ? { adaptedFrom: { id: stored[0].m.meta.id, topic: stored[0].m.meta.topic } } : {}) }

  const d = best.draft
  const code: Code = { html: d.html, css: d.css, js: d.js }
  const result: BackgroundResult = { background: { code, concept: d.concept }, concept: d.concept, score: best.score, rounds: used }
  if (stored[0]) result.adaptedFrom = { id: stored[0].m.meta.id, topic: stored[0].m.meta.topic }
  // good enough to keep for later films on similar topics
  if (inp.library && best.score >= KEEP_SCORE) {
    try {
      const meta = inp.library.save(
        {
          topic: clip(b.topic, 500),
          keywords: [...new Set([...d.keywords, ...keywordsOf(`${b.topic} ${b.product ?? ''}`, 8)])].slice(0, 20),
          mood: d.mood || b.mood || '',
          palette: d.palette.length ? d.palette : [b.accent ? `#${b.accent.replace('#', '')}` : '#4f8cff'],
          concept: d.concept,
          model: inp.modelName ?? inp.model ?? inp.chat.label,
          score: best.score,
          aspects: [aspect],
          size: inp.size,
          durationSec: inp.durationSec,
          kind: b.kind,
          usesThree: /\bfrom\s*['"]three['"]/.test(d.js),
          ...(result.adaptedFrom ? { adaptedFrom: result.adaptedFrom.id } : inp.family?.id ? { adaptedFrom: inp.family.id } : {})
        } satisfies Omit<BackgroundMeta, 'id' | 'createdAt'>,
        code,
        playablePage(code, inp.size, inp.durationSec),
        best.bgFrame ?? undefined
      )
      result.savedId = meta.id
      result.background!.id = meta.id
      if (result.adaptedFrom) inp.library.markAdapted(result.adaptedFrom.id)
    } catch (err) {
      say(`  background: it could not be saved to the library (${String((err as Error)?.message ?? err).slice(0, 100)})`)
    }
  }
  writeFileSync(join(inp.dir, `background-${b.kind}.json`), JSON.stringify({ code, concept: d.concept, id: result.savedId }, null, 2))
  return result
}
