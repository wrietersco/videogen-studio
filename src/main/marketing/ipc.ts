import { BrowserWindow, ipcMain, Notification, shell } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { cardPatchOf, isBusinessId, isCardId, isMarketRunId, normalizeDomain, type BusinessProfile, type MarketEvent, type MarketJob, type MarketRunRecord, type MarketStage } from '../../shared/marketing'
import type { LLMProvider, SpeechProvider } from '../providers/types'
import type { MediaTools } from '../appRecon/run'
import { meter, readProjectUsage, type ProjectUsage } from '../usage/meter'
import { readSite, unifiedMd } from './crawl'
import { brandOf, readFacts } from './profile'
import { generateCards } from './cards'
import { FilmCancelled, runMarketingFilm } from './film'
import type { MarketingStore } from './store'

/**
 * The bridge of "market your business": saving a domain reads the site into a
 * profile; the person edits the video cards; one button makes one card's film
 * with the same engine that records apps, minus the recording.
 */

export interface MarketingIpcDeps {
  store: MarketingStore
  emit: (channel: string, payload: unknown) => void
  window: () => BrowserWindow | null
  /** the app runs one heavy job at a time (shared with video generation and footage) */
  isBusy: () => boolean
  setBusy: (busy: boolean) => void
  /** whether the AI writer and voice may be used on this account, and if not, why */
  ai: () => { available: boolean; reason?: string }
  providers: () => { chat: LLMProvider | null; speech: SpeechProvider | null }
  /** runs work that calls AI models as one AI video of the person's plan */
  aiJob: <T>(projectKey: string, title: string, fn: () => Promise<T>) => Promise<T>
  /** the AI clip, picture and music models for one run, or null when none is available */
  media?: (runId: string) => MediaTools | null
  /** the most AI clips the account may put in one film (0 = none) */
  maxClips: () => number
  /** replaceable for tests */
  crawler?: typeof readSite
  filmmaker?: typeof runMarketingFilm
}

const rid = (prefix: string, n: number) => `${prefix}-${randomBytes(n).toString('hex').slice(0, n * 2)}`
const CARD_COUNT = 5

export function registerMarketingIpc(d: MarketingIpcDeps): void {
  const fail = (err: unknown) => ({ ok: false as const, error: String((err as Error)?.message ?? err) })
  const send = (e: MarketEvent) => d.emit('market:event', e)
  /** the one job this feature runs at a time (a site read or a film) */
  let current: { businessId: string; job: MarketJob; runId?: string; abort: AbortController } | null = null
  const notify = (title: string, body: string) => {
    try {
      if (Notification.isSupported()) new Notification({ title, body }).show()
    } catch {
      /* no notifications here */
    }
  }

  ipcMain.handle('market:state', () => ({
    businesses: d.store.list(),
    runs: d.store.runs(),
    ai: d.ai(),
    current: current ? { businessId: current.businessId, job: current.job, runId: current.runId } : null
  }))

  /** the business's whole site read as one file, for the person to check */
  ipcMain.handle('market:siteMd', (_e, id: unknown) => {
    if (!isBusinessId(id)) return { ok: false as const, error: 'Invalid business' }
    const p = d.store.get(id)
    if (!p) return { ok: false as const, error: 'That business no longer exists' }
    try {
      return { ok: true as const, md: readFileSync(join(d.store.dirOf(id), p.siteMd || 'site.md'), 'utf8').slice(0, 120000) }
    } catch {
      return { ok: false as const, error: 'The site read could not be opened' }
    }
  })

  /**
   * Save a domain: reads the site (home + services pages), takes the brand,
   * writes the profile and the first cards. Everything after the save happens
   * in the background and reaches the screen as events.
   */
  ipcMain.handle('market:save', async (_e, raw: unknown) => {
    const domain = (typeof raw === 'string' ? raw : String((raw as { domain?: unknown })?.domain ?? '')).trim()
    const v = normalizeDomain(domain)
    if (!v.ok) return v
    if (current || d.isBusy()) return fail('Another job is running. Wait for it to finish, then try again.')
    const existing = d.store.list().find((p) => p.domain === v.host)
    const id = existing?.id ?? rid('biz', 6)
    const now = new Date().toISOString()
    const profile: BusinessProfile = existing
      ? { ...existing, domain: v.host }
      : { id, domain: v.host, name: v.host, tagline: '', about: '', services: [], brand: { colors: [] }, cards: [], siteMd: 'site.md', notes: [], createdAt: now, updatedAt: now }
    d.store.save(profile)
    return runAnalyze(profile)
  })

  /** read the site again (the business changed, or the first read failed) */
  ipcMain.handle('market:reanalyze', (_e, id: unknown) => {
    if (!isBusinessId(id)) return fail('Invalid business')
    const profile = d.store.get(id)
    if (!profile) return fail('That business no longer exists')
    if (current || d.isBusy()) return fail('Another job is running. Wait for it to finish, then try again.')
    return runAnalyze(profile)
  })

  async function runAnalyze(profile: BusinessProfile): Promise<{ ok: true; businessId: string }> {
    const job: MarketJob = 'analyze'
    current = { businessId: profile.id, job, abort: new AbortController() }
    d.setBusy(true)
    send({ kind: 'started', businessId: profile.id, job })
    const say = (m: string) => send({ kind: 'log', businessId: profile.id, job, message: m })
    const progress = (stage: MarketStage, message: string) => send({ kind: 'stage', businessId: profile.id, job, stage, message })

    void (async () => {
      try {
        const ai = d.ai()
        const useAi = ai.available
        const chat = useAi ? d.providers().chat : null
        const dir = d.store.dirOf(profile.id)
        progress('fetch', `Opening ${profile.domain}`)
        const read = await (d.crawler ?? readSite)(profile.domain, { dir, chat, log: say })
        progress('read', 'Reading the pages')
        writeFileSync(join(dir, profile.siteMd || 'site.md'), unifiedMd(read))
        progress('brand', 'Taking the brand')
        const facts = await readFacts(read, { chat, say })
        progress('ideas', 'Writing the video ideas')
        const cards = await generateCards({ ...profile, name: facts.name, tagline: facts.tagline, about: facts.about, services: facts.services }, { chat, count: CARD_COUNT, idOf: () => rid('card', 6), say })
        const next: BusinessProfile = {
          ...profile,
          name: facts.name,
          tagline: facts.tagline,
          about: facts.about,
          services: facts.services,
          brand: brandOf(read),
          // cards the person already has (perhaps edited) are kept; a fresh read only fills empty ones
          cards: profile.cards.length && profile.about ? profile.cards : cards,
          notes: read.notes,
          updatedAt: new Date().toISOString()
        }
        const saved = d.store.save(next)
        send({ kind: 'done', businessId: profile.id, job, profile: saved })
        notify('Your business profile is ready', `${saved.name}: ${saved.cards.length} video ideas`)
      } catch (err) {
        const cancelled = err instanceof FilmCancelled || current?.abort.signal.aborted
        send({ kind: cancelled ? 'cancelled' : 'failed', businessId: profile.id, job, error: String((err as Error)?.message ?? err) })
      } finally {
        current = null
        d.setBusy(false)
      }
    })()
    return { ok: true, businessId: profile.id }
  }

  // ------------------------------------------------------------ the cards

  ipcMain.handle('market:updateCard', (_e, businessId: unknown, cardId: unknown, patch: unknown) => {
    const at = cardAt(businessId, cardId)
    if (!at) return fail('That card no longer exists')
    at.profile.cards[at.index] = { ...at.profile.cards[at.index], ...cardPatchOf(patch) }
    d.store.save(at.profile)
    return { ok: true as const, profile: at.profile }
  })

  ipcMain.handle('market:addCard', (_e, businessId: unknown) => {
    const at = d.store.get(String(businessId ?? ''))
    if (!at || !isBusinessId(businessId)) return fail('That business no longer exists')
    at.cards.push({ id: rid('card', 6), title: 'New video idea', problem: 'Describe the trouble your customer faces (never name the business here).', solution: `Describe how ${at.name} answers it.`, cta: 'Book a free call', targetSec: 25 })
    d.store.save(at)
    return { ok: true as const, profile: at }
  })

  ipcMain.handle('market:removeCard', (_e, businessId: unknown, cardId: unknown) => {
    const at = cardAt(businessId, cardId)
    if (!at) return fail('That card no longer exists')
    at.profile.cards.splice(at.index, 1)
    d.store.save(at.profile)
    return { ok: true as const, profile: at.profile }
  })

  ipcMain.handle('market:moreIdeas', async (_e, businessId: unknown) => {
    const profile = d.store.get(String(businessId ?? ''))
    if (!profile || !isBusinessId(businessId)) return fail('That business no longer exists')
    const ai = d.ai()
    const chat = ai.available ? d.providers().chat : null
    try {
      const fresh = await generateCards(profile, { chat, count: 3, idOf: () => rid('card', 6), say: () => undefined })
      profile.cards = [...profile.cards, ...fresh.filter((c) => !profile.cards.some((x) => x.title === c.title))].slice(0, 12)
      d.store.save(profile)
      return { ok: true as const, profile }
    } catch (err) {
      return fail(err)
    }
  })

  // ------------------------------------------------------------ the films

  ipcMain.handle('market:start', (_e, businessId: unknown, cardId: unknown) => {
    const at = cardAt(businessId, cardId)
    if (!at) return fail('That card no longer exists')
    if (current || d.isBusy()) return fail('Another job is running. Wait for it to finish, then try again.')
    const card = at.profile.cards[at.index]
    const profile = at.profile
    const rec = d.store.newRun(profile.id, card.id)
    current = { businessId: profile.id, job: 'film', runId: rec.id, abort: new AbortController() }
    d.setBusy(true)
    send({ kind: 'started', businessId: profile.id, job: 'film', runId: rec.id, cardId: card.id })

    const ai = d.ai()
    const useAi = ai.available
    const tools = useAi ? (d.media?.(rec.id) ?? null) : null
    const maxClips = d.maxClips()
    const make = () =>
      (d.filmmaker ?? runMarketingFilm)({
        runDir: d.store.runDir(rec.id),
        card,
        profile,
        chat: useAi ? d.providers().chat : null,
        speech: useAi ? d.providers().speech : null,
        tools,
        aiMusic: !!tools?.music,
        maxClips,
        signal: current?.abort.signal,
        progress: (stage, message) => {
          rec.stage = stage
          send({ kind: 'stage', businessId: profile.id, job: 'film', runId: rec.id, stage, message })
        },
        log: (message) => send({ kind: 'log', businessId: profile.id, job: 'film', runId: rec.id, message })
      })

    void (async () => {
      meter.begin('business-film')
      let record: MarketRunRecord = rec
      try {
        const out = useAi ? await d.aiJob(`mk-${rec.id}`, `${profile.name} — ${card.title}`, make) : await make()
        record = { ...rec, status: 'done', finishedAt: new Date().toISOString(), video: out.file, durationSec: out.durationSec, notes: out.notes }
        card.video = out.file
        card.runId = rec.id
        d.store.save(profile)
        send({ kind: 'done', businessId: profile.id, job: 'film', runId: rec.id, run: record })
        notify('Your business video is ready', card.title)
      } catch (err) {
        const cancelled = err instanceof FilmCancelled || current?.abort.signal.aborted
        record = { ...rec, status: cancelled ? 'cancelled' : 'failed', finishedAt: new Date().toISOString(), error: cancelled ? undefined : String((err as Error)?.message ?? err) }
        send({ kind: cancelled ? 'cancelled' : 'failed', businessId: profile.id, job: 'film', runId: rec.id, error: record.error ?? '', run: record })
      } finally {
        d.store.saveRun(record)
        meter.end(d.store.runDir(rec.id))
        current = null
        d.setBusy(false)
      }
    })()
    return { ok: true as const, runId: rec.id }
  })

  ipcMain.handle('market:cancel', () => {
    if (!current) return false
    current.abort.abort()
    return true
  })

  function cardAt(businessId: unknown, cardId: unknown): { profile: BusinessProfile; index: number } | null {
    if (!isBusinessId(businessId) || !isCardId(cardId)) return null
    const profile = d.store.get(businessId)
    if (!profile) return null
    const index = profile.cards.findIndex((c) => c.id === cardId)
    return index < 0 ? null : { profile, index }
  }

  /** the film, only from inside its own run folder */
  const videoOf = (runId: unknown): string | null => {
    if (!isMarketRunId(runId)) return null
    const rec = d.store.runs().find((r) => r.id === runId)
    if (!rec?.video) return null
    const file = rec.video
    return file.startsWith(d.store.runDir(runId)) && existsSync(file) ? file : null
  }
  ipcMain.handle('market:play', async (_e, runId: unknown) => {
    const f = videoOf(runId)
    return f ? (await shell.openPath(f)) === '' : false
  })
  ipcMain.handle('market:reveal', (_e, runId: unknown) => {
    const f = videoOf(runId)
    if (!f) return false
    shell.showItemInFolder(f)
    return true
  })
  ipcMain.handle('market:runUsage', (_e, runId: unknown) => (isMarketRunId(runId) ? readProjectUsage(d.store.runDir(runId)) : { runs: [], totalUsd: 0, savedUsd: 0 }))

  /** erase one film from this PC; only the cost stays in the totals */
  ipcMain.handle('market:removeRun', (_e, runId: unknown) => {
    if (!isMarketRunId(runId)) return fail('Invalid film')
    if (current?.runId === runId) return fail('This film is still being made. Stop it first.')
    try {
      const dir = d.store.runDir(runId)
      if (!existsSync(join(dir, 'run.json'))) return fail('This film is already gone')
      const usage: ProjectUsage = readProjectUsage(dir)
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      if (existsSync(dir)) return fail('Some files are still in use. Close any player showing this video and try again.')
      // the card that pointed at the film lets go of it
      for (const p of d.store.list()) {
        let changed = false
        for (const c of p.cards) if (c.runId === runId) { c.runId = undefined; c.video = undefined; changed = true }
        if (changed) d.store.save(p)
      }
      return { ok: true as const, usage }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('market:remove', (_e, id: unknown) => {
    if (!isBusinessId(id)) return fail('Invalid business')
    if (current?.businessId === id) return fail('This business is busy. Stop the job first.')
    try {
      d.store.remove(id)
      return { ok: true as const }
    } catch (err) {
      return fail(err)
    }
  })
}
