import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { appReconDir, footageDir, libraryDir, marketingDir, projectsDir } from '../paths'
import type { FeedbackContext, FeedbackMode } from '../../shared/feedback'

/**
 * Everything a finished video was made of, gathered from where each mode
 * already keeps it on disk (projects/<id>/, app-recordings/runs/<id>/,
 * business-profiles/runs/<id>/). Called when feedback is saved, so the entry
 * carries its own copy and survives the video and its folder. A missing or
 * unreadable file just leaves that part out — giving an opinion never fails.
 */

export interface CaptureRoots {
  projects: string
  appRecon: string
  marketing: string
  footage: string
  library: string
}

export const captureRoots = (): CaptureRoots => ({ projects: projectsDir, appRecon: appReconDir, marketing: marketingDir, footage: footageDir, library: libraryDir })

/** a plain id safe to use as a folder name (project, run and mrun ids all match) */
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i

function subDir(base: string, ...parts: string[]): string | null {
  if (!parts.every((p) => SAFE_ID.test(p))) return null
  const root = resolve(base)
  const dir = resolve(root, ...parts)
  return dir.startsWith(root + sep) ? dir : null
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown, max = 4000): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** ---- Create (Studio): projects/<id>/{project.json, spec.json, brand.json} ---- */
function captureCreate(videoId: string, roots: CaptureRoots): FeedbackContext {
  const dir = subDir(roots.projects, videoId) ?? ''
  const meta = obj(readJson(join(dir, 'project.json')))
  const spec = obj(readJson(join(dir, 'spec.json')))
  const brand = obj(readJson(join(dir, 'brand.json')))
  const renders = arr(meta?.renders).map(obj).filter(Boolean)
  return {
    videoPath: str(renders.at(-1)?.file),
    prompt: str(meta?.prompt) ?? str(spec?.title) ?? '',
    platform: str(meta?.platform) ?? str(spec?.platform),
    style: str(spec?.style),
    durationSec: num(spec?.durationSec),
    brand: brand ?? undefined,
    decisions: {
      title: str(spec?.title),
      pacing: str(spec?.pacing),
      fps: num(spec?.fps),
      musicMood: str(spec?.musicMood),
      captionStyle: obj(spec?.captionStyle) ?? undefined,
      voice: obj(spec?.voice) ?? undefined,
      sceneGrid: obj(spec?.sceneGrid) ?? undefined,
      palette: str(spec?.palette),
      typography: str(spec?.typography),
      sceneCount: arr(spec?.scenes).length,
      narration: arr(spec?.narration)
        .map(obj)
        .map((n) => str(n?.text, 1000))
        .filter((t): t is string => Boolean(t)),
      refs: arr(spec?.refs).length,
      styleBrief: obj(spec?.styleBrief) ?? undefined,
      videoBrief: obj(spec?.videoBrief) ?? undefined,
      crafts: arr(spec?.crafts).length,
      customScenes: arr(spec?.customScenes).length,
      customVideos: arr(spec?.customVideos).length
    },
    extras: { status: str(meta?.status) }
  }
}

/** ---- Record an app: app-recordions/runs/<id>/{run.json, beats.json} + apps.json ---- */
function captureApp(videoId: string, roots: CaptureRoots): FeedbackContext {
  const dir = subDir(roots.appRecon, 'runs', videoId) ?? ''
  const run = obj(readJson(join(dir, 'run.json')))
  const appId = str(run?.appId, 60)
  const app = appId ? arr(readJson(join(roots.appRecon, 'apps.json'))).map(obj).find((a) => a && str(a.id, 60) === appId) ?? null : null
  const beats = arr(readJson(join(dir, 'beats.json')))
    .map(obj)
    .map((b) => ({ kind: str(b?.kind, 40), chapter: str(b?.chapter, 80), text: str(b?.text, 500) }))
    .slice(0, 40)
  const brandId = str(app?.brandId, 60)
  return {
    videoPath: str(run?.video),
    prompt: str(app?.context) ?? '',
    platform: str(app?.platform),
    durationSec: num(run?.durationSec),
    targetSec: num(app?.targetSec),
    brand: brandId ? { kitId: brandId, source: str(app?.brandSource, 20) } : undefined,
    decisions: {
      app: {
        name: str(app?.name, 120),
        url: str(app?.url, 300),
        signIn: str(app?.signIn, 10),
        depth: str(app?.depth, 12),
        mode: str(app?.mode, 12),
        launch: obj(app?.launch) ?? undefined,
        targetSec: num(app?.targetSec),
        platform: str(app?.platform),
        useAi: app?.useAi === true,
        aiMedia: app?.aiMedia === true,
        aiMusic: app?.aiMusic === true,
        agentMode: str(app?.agentMode, 12),
        reviewFirst: app?.reviewFirst === true,
        checks: obj(app?.checks) ?? undefined,
        guardrailText: str(app?.guardrailText),
        styleNotes: str(app?.styleNotes),
        styleLinks: arr(app?.styleLinks).slice(0, 3),
        document: obj(app?.document) ? { name: str(obj(app?.document)?.name, 200), chars: str(obj(app?.document)?.text)?.length ?? 0 } : undefined
      },
      run: { pages: num(run?.pages), actions: num(run?.actions), notes: arr(run?.notes).slice(0, 20) },
      beats
    }
  }
}

/** ---- Market my business: business-profiles/runs/<id>/{run.json, market-plan.json} + businesses.json ---- */
function captureMarket(videoId: string, roots: CaptureRoots): FeedbackContext {
  const dir = subDir(roots.marketing, 'runs', videoId) ?? ''
  const run = obj(readJson(join(dir, 'run.json')))
  const plan = obj(obj(readJson(join(dir, 'market-plan.json')))?.plan)
  const businessId = str(run?.businessId, 60)
  const profile = businessId ? arr(readJson(join(roots.marketing, 'businesses.json'))).map(obj).find((p) => p && str(p.id, 60) === businessId) ?? null : null
  const brand = obj(profile?.brand)
  const cardId = str(run?.cardId, 60)
  const card = cardId ? arr(profile?.cards).map(obj).find((c) => c && str(c.id, 60) === cardId) ?? null : null
  return {
    videoPath: str(run?.video),
    prompt: str(card?.brief) ?? str(card?.title) ?? str(plan?.goal) ?? '',
    platform: str(card?.platform) ?? str(plan?.platform),
    durationSec: num(run?.durationSec),
    targetSec: num(card?.targetSec) ?? num(plan?.targetSec),
    brand: profile ? { name: str(profile.name, 120), tagline: str(profile.tagline, 200), domain: str(profile.domain, 200), colors: arr(brand?.colors).slice(0, 8), accent: str(brand?.accent, 12) } : undefined,
    decisions: {
      card: {
        title: str(card?.title, 80),
        problem: str(card?.problem, 400),
        solution: str(card?.solution, 400),
        cta: str(card?.cta, 60),
        targetSec: num(card?.targetSec),
        platform: str(card?.platform)
      },
      plan: {
        goal: str(plan?.goal),
        service: str(plan?.service, 120),
        audience: str(plan?.audience, 200),
        problem: obj(plan?.problem) ?? undefined,
        points: arr(plan?.points)
          .map(obj)
          .map((p) => str(p?.say, 300) ?? str(p?.text, 300))
          .filter((s): s is string => Boolean(s))
          .slice(0, 12),
        close: obj(plan?.close) ?? undefined,
        music: str(plan?.music, 40),
        voice: str(plan?.voice, 40),
        look: str(plan?.look, 200),
        avoid: arr(plan?.avoid).slice(0, 10)
      },
      business: { domain: str(profile?.domain, 200), name: str(profile?.name, 120) },
      agentMode: str(profile?.agentMode, 12)
    },
    extras: {
      revision: obj(run?.revision) ?? undefined,
      parentRunId: str(run?.parentRunId, 60),
      shortfalls: arr(run?.shortfalls).slice(0, 20),
      engineNotes: arr(run?.notes).slice(0, 20)
    }
  }
}

/** ---- Edit footage: footage/<projectId>/project.json holds the edits; the video id is the edit's id ---- */
function captureFootage(videoId: string, roots: CaptureRoots): FeedbackContext {
  const base = resolve(roots.footage)
  let dirs: string[] = []
  try {
    dirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && SAFE_ID.test(d.name)).map((d) => d.name)
  } catch {
    /* no footage folder */
  }
  for (const name of dirs) {
    const project = obj(readJson(join(base, name, 'project.json')))
    const edit = arr(project?.edits).map(obj).find((e) => e && str(e.id, 60) === videoId)
    if (!edit) continue
    return {
      videoPath: str(edit.file, 600),
      prompt: str(edit.prompt) ?? str(edit.title) ?? '',
      platform: str(edit.shape, 40),
      durationSec: num(edit.durationSec),
      decisions: { title: str(edit.title, 200), shape: str(edit.shape, 40), project: { id: name, name: str(project?.name, 120), clips: arr(project?.clips).length } },
      extras: { madeAt: str(edit.createdAt, 40) }
    }
  }
  return { prompt: '', decisions: {} }
}

/** ---- Library asset (image, clip, voice, music, sound): library/<kind>/<id>.json sidecar ---- */
function captureAsset(videoId: string, roots: CaptureRoots): FeedbackContext {
  const base = resolve(roots.library)
  let kinds: string[] = []
  try {
    kinds = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && SAFE_ID.test(d.name)).map((d) => d.name)
  } catch {
    /* no library folder */
  }
  for (const kind of kinds) {
    const file = join(base, kind, `${videoId}.json`)
    if (!existsSync(file)) continue
    const a = obj(readJson(file))
    if (!a) break
    return {
      videoPath: str(a.file) ? join(base, kind, str(a.file, 200)!) : undefined,
      prompt: str(a.prompt) ?? str(a.title) ?? '',
      durationSec: num(a.durationSec),
      decisions: { kind: str(a.kind, 20), source: str(a.source, 20), provider: str(a.provider, 60), model: str(a.model, 100), title: str(a.title, 200), tags: arr(a.tags).slice(0, 12), width: num(a.width), height: num(a.height), extra: obj(a.extra) ?? undefined },
      extras: { costUsd: num(a.costUsd), usedIn: arr(a.usedIn).length }
    }
  }
  return { prompt: '', decisions: {} }
}

/** the video's own story — prompt, brand and every setting — as it still exists on disk */
export function captureFeedbackContext(mode: FeedbackMode, videoId: string, roots: CaptureRoots = captureRoots()): FeedbackContext {
  if (mode === 'app') return captureApp(videoId, roots)
  if (mode === 'market') return captureMarket(videoId, roots)
  if (mode === 'footage') return captureFootage(videoId, roots)
  if (mode === 'asset') return captureAsset(videoId, roots)
  return captureCreate(videoId, roots)
}
