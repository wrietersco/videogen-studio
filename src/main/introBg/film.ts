import { join } from 'node:path'
import type { LLMProvider } from '../providers/types'
import { directBackground, type BackgroundBrief, type BackgroundResult } from './director'
import type { SceneBackground } from './kit'
import type { IntroBackgroundLibrary } from './library'

/**
 * What a film asks of the intro-background director: its title scene and its
 * closing scene each get a background designed for this film (the closing
 * scene belongs to the title scene's family). The caller renders the scenes
 * over these; a scene that has none uses the drawn motif, and `notes` says so.
 */

export interface SceneWords {
  pill?: string
  headline: string
  sub?: string
}

export interface FilmBackgroundsInput {
  /** null / the mock engine = no writer, nothing is designed */
  chat: LLMProvider | null
  library: IntroBackgroundLibrary | null
  /** scratch folder (frames of every round) */
  dir: string
  size: { width: number; height: number }
  /** what the film is about */
  topic: string
  product?: string
  about?: string
  narration?: string
  title: SceneWords
  outro?: SceneWords
  hasLogo?: boolean
  logo?: string
  accent?: string
  backdrop?: [string, string]
  colors?: string[]
  style?: string | null
  mood?: string
  pictures?: string[]
  /** how long the scenes are (the page paces itself by DURATION, so this is a design length) */
  titleSec?: number
  outroSec?: number
  /** the name the drawn motif goes by in the notes ("graph", "flow", "cards") */
  drawnName: string
  model?: string
  say?: (m: string) => void
  signal?: AbortSignal
  rounds?: number
}

export interface FilmBackgrounds {
  title?: SceneBackground
  outro?: SceneBackground
  /** what to tell the person, in plain words */
  notes: string[]
  /** what each scene's director run reported (for the record) */
  results: { title?: BackgroundResult; outro?: BackgroundResult }
}

const one = (s: string, n = 220): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function describe(label: string, r: BackgroundResult): string {
  const kept = r.savedId ? ' It was kept in your intro-background library for similar films.' : ''
  const from = r.adaptedFrom ? ` It started from a stored background on a similar topic ("${one(r.adaptedFrom.topic, 70)}") and was redesigned for this film.` : ''
  return `The ${label} was designed for this film: ${one(r.concept ?? '')} (${r.rounds} round${r.rounds === 1 ? '' : 's'}, the AI scored it ${Math.round((r.score ?? 0) * 10) / 10}/10).${from}${kept}`
}

export async function designFilmBackgrounds(inp: FilmBackgroundsInput): Promise<FilmBackgrounds> {
  const out: FilmBackgrounds = { notes: [], results: {} }
  const say = inp.say ?? (() => undefined)
  if (!inp.chat || inp.chat.id === 'mock') {
    out.notes.push(`No AI writer is set up, so the title and closing scenes use the drawn "${inp.drawnName}" motif.`)
    return out
  }
  const common: Omit<BackgroundBrief, 'kind' | 'headline' | 'pill' | 'sub'> = {
    topic: inp.topic,
    product: inp.product,
    about: inp.about,
    narration: inp.narration,
    hasLogo: inp.hasLogo,
    accent: inp.accent,
    backdrop: inp.backdrop,
    colors: inp.colors,
    style: inp.style,
    mood: inp.mood
  }
  const run = async (kind: 'title' | 'outro', words: SceneWords, family?: SceneBackground): Promise<BackgroundResult> => {
    say(`Designing the ${kind === 'title' ? 'title' : 'closing'} scene's background`)
    return directBackground({
      chat: inp.chat!,
      brief: { ...common, kind, pill: words.pill, headline: words.headline, sub: words.sub },
      size: inp.size,
      durationSec: kind === 'title' ? inp.titleSec ?? 6 : inp.outroSec ?? 6,
      dir: join(inp.dir, kind),
      library: inp.library,
      pictures: inp.pictures,
      family: family ? { code: family.code, concept: family.concept ?? '', id: family.id } : undefined,
      logo: inp.logo,
      model: inp.model,
      signal: inp.signal,
      // the closing scene starts from the title's design, so it needs fewer rounds
      rounds: kind === 'outro' ? Math.min(2, inp.rounds ?? 3) : inp.rounds,
      say
    })
  }
  let title: BackgroundResult | null = null
  try {
    title = await run('title', inp.title)
  } catch (err) {
    if (inp.signal?.aborted || String((err as Error)?.message) === 'cancelled') throw err
    out.notes.push(`The AI could not design the title background (${one(String((err as Error)?.message ?? err), 120)}), so the drawn "${inp.drawnName}" motif is used.`)
  }
  if (title?.background) {
    out.title = title.background
    out.results.title = title
    out.notes.push(describe("title scene's background", title))
    if (inp.outro) {
      try {
        const o = await run('outro', inp.outro, title.background)
        if (o.background) {
          out.outro = o.background
          out.results.outro = o
          out.notes.push(describe("closing scene's background", o))
        } else {
          // never the drawn motif when the title has a design: the closing scene stays in the title's family
          out.outro = title.background
          out.notes.push(`The closing scene's own background could not be designed (${one(o.why ?? 'unknown', 100)}), so it uses the title scene's background.`)
        }
      } catch (err) {
        if (inp.signal?.aborted || String((err as Error)?.message) === 'cancelled') throw err
        out.outro = title.background
        out.notes.push(`The closing scene's own background could not be designed (${one(String((err as Error)?.message ?? err), 100)}), so it uses the title scene's background.`)
      }
    }
  } else if (title) {
    out.results.title = title
    out.notes.push(`The AI could not design a background for this film (${one(title.why ?? 'unknown', 120)}), so the title and closing scenes use the drawn "${inp.drawnName}" motif.`)
  }
  return out
}
