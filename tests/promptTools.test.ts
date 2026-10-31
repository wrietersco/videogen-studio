import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VIDEO_SHAPES, platformForShape, shapeOf } from '../src/shared/shapes'
import { PLATFORM_PRESETS } from '../src/shared/presets'
import { PlatformId } from '../src/shared/spec'
import { BUILTIN_TEMPLATES, DEFAULT_SECTIONS, assemblePrompt, templateSkeleton } from '../src/shared/promptTemplates'
import { alignSections, basicEnhance, beatCount, enhancePrompt } from '../src/main/promptEnhancer'
import { honorShape } from '../src/main/autopilot'
import { PromptTemplateStore } from '../src/main/store/promptTemplates'
import { MockProvider } from '../src/main/providers/mock'
import { isIsometricOnlyBrief } from '../src/main/pipeline/orchestrator'
import type { GenerateJSONRequest, LLMProvider } from '../src/main/providers/types'

/** a stand-in chat model that returns a canned brief and records what it was asked */
function fakeModel(reply: unknown): LLMProvider & { asked: GenerateJSONRequest[] } {
  const asked: GenerateJSONRequest[] = []
  return {
    id: 'openai',
    label: 'fake',
    asked,
    isConfigured: async () => true,
    listModels: async () => [],
    generateText: async () => '',
    generateJSON: async <T,>(req: GenerateJSONRequest) => {
      asked.push(req)
      if (reply instanceof Error) throw reply
      return reply as T
    }
  }
}

describe('video shapes', () => {
  it('cover every platform, and every platform maps to a shape', () => {
    for (const id of PlatformId.options) expect(VIDEO_SHAPES.map((s) => s.id)).toContain(shapeOf(id))
    for (const s of VIDEO_SHAPES) expect(shapeOf(s.defaultPlatform)).toBe(s.id)
    expect(PLATFORM_PRESETS.square).toMatchObject({ width: 1080, height: 1080, aspectLabel: '1:1' })
  })

  it('keep the chosen app when it already has the shape', () => {
    expect(platformForShape('9:16', 'instagram-reels')).toBe('instagram-reels')
    expect(platformForShape('16:9', 'instagram-reels')).toBe('youtube')
    expect(platformForShape('1:1')).toBe('square')
  })

  it('autopilot honors a shape the person picked, but keeps a same-shape app choice', () => {
    const decision = { platform: 'youtube' as const, styleHint: 'explainer' as const, durationHintSec: 120, look: 'infographic' as const, reason: 'long explainer' }
    const tall = honorShape(decision, 'tiktok')
    expect(tall.platform).toBe('tiktok')
    expect(tall.durationHintSec).toBe(PLATFORM_PRESETS.tiktok.durationRange[1])
    expect(tall.reason).toMatch(/9:16/)
    expect(honorShape({ ...decision, platform: 'instagram-reels', durationHintSec: 30 }, 'tiktok').platform).toBe('instagram-reels')
  })
})

describe('prompt enhancer', () => {
  it('tidies up offline without inventing anything', async () => {
    const out = await enhancePrompt(new MockProvider(), { idea: '  why cats   purr ', platform: 'tiktok', styleHint: 'explainer', durationSec: 30 })
    expect(out.source).toBe('basic')
    expect(out.sections.map((s) => s.label)).toEqual(DEFAULT_SECTIONS.map((s) => s.label))
    expect(out.prompt).toMatch(/^Video: why cats purr/)
    expect(out.prompt).toContain(`${beatCount(30)} short scenes`)
    expect(out.prompt).not.toMatch(/Must include|Avoid/) // empty sections are left out
  })

  it('refuses an empty idea', async () => {
    await expect(enhancePrompt(new MockProvider(), { idea: '   ' })).rejects.toThrow(/idea/)
  })

  it('asks the model for the requested structure and keeps it even when the reply drifts', async () => {
    const model = fakeModel({
      title: 'Purr Science',
      sections: [
        { label: 'VIDEO', content: 'Why cats purr', hint: 'The topic' },
        { label: 'Story Beats', content: '1. A cat purrs on a lap\n2. The larynx vibrates', hint: 'Numbered moments' },
        { label: 'Extra', content: 'ignored', hint: '' }
      ]
    })
    const sections = BUILTIN_TEMPLATES[0].sections
    const out = await enhancePrompt(model, { idea: 'why cats purr', platform: 'youtube', durationSec: 60, sections })
    const sent = JSON.parse(model.asked[0].prompt)
    expect(sent.sections.map((s: { label: string }) => s.label)).toEqual(sections.map((s) => s.label))
    expect(sent.storyBeats).toBe(beatCount(60))
    expect(out.source).toBe('ai')
    expect(out.title).toBe('Purr Science')
    expect(out.sections.map((s) => s.label)).toEqual(sections.map((s) => s.label))
    expect(out.prompt).toBe('Video: Why cats purr\nStory beats:\n1. A cat purrs on a lap\n2. The larynx vibrates')
  })

  it('never switches a normal idea to the isometric-only pipeline, and keeps it when asked', async () => {
    const sneaky = fakeModel({ title: 't', sections: [{ label: 'Video', content: 'Coffee', hint: '' }, { label: 'Visual style', content: 'Isometric animation throughout', hint: '' }] })
    const normal = await enhancePrompt(sneaky, { idea: 'how coffee is made' })
    expect(isIsometricOnlyBrief(normal.prompt)).toBe(false)

    const lost = fakeModel({ title: 't', sections: [{ label: 'Video', content: 'Coffee', hint: '' }, { label: 'Visual style', content: 'Clean flat graphics', hint: '' }] })
    const iso = await enhancePrompt(lost, { idea: 'an isometric animation of how coffee is made' })
    expect(isIsometricOnlyBrief(iso.prompt)).toBe(true)
  })

  it('falls back to the offline tidy-up when the model fails', async () => {
    const out = await enhancePrompt(fakeModel(new Error('rate limited')), { idea: 'a product promo for my candle shop' })
    expect(out.source).toBe('basic')
    expect(out.note).toMatch(/rate limited/)
    expect(out.prompt).toContain('candle shop')
  })

  it('aligns sections by position when labels are reworded', () => {
    const wanted = [{ label: 'Video', hint: 'a' }, { label: 'Hook', hint: 'b' }]
    const got = alignSections(wanted, [{ label: 'Topic', content: 'x', hint: '' }, { label: 'Opening', content: 'y', hint: 'h' }])
    expect(got).toEqual([{ label: 'Video', content: 'x', hint: 'a' }, { label: 'Hook', content: 'y', hint: 'h' }])
  })

  it('assembles and skeletons briefs in the labelled form', () => {
    expect(assemblePrompt([{ label: 'A', content: 'one' }, { label: 'B', content: '' }, { label: 'C', content: '1. x\n2. y' }])).toBe('A: one\nC:\n1. x\n2. y')
    expect(templateSkeleton(BUILTIN_TEMPLATES[1])).toMatch(/^Video: \nAudience: /)
    expect(basicEnhance({ idea: 'x' }, [{ label: 'Whatever', hint: '' }]).prompt).toBe('Whatever: x')
  })
})

describe('prompt templates', () => {
  const store = () => new PromptTemplateStore(join(mkdtempSync(join(tmpdir(), 'tpl-')), 'nested', 'prompt-templates.json'))

  it('lists starters, saves and deletes the person’s own (starters cannot be deleted)', () => {
    const s = store()
    expect(s.list().every((t) => t.builtin)).toBe(true)
    const saved = s.save({ name: ' Weekly tip ', sections: [{ label: 'Video', hint: 'topic' }, { label: 'video', hint: 'dup' }, { label: 'Hook', hint: '' }], platform: 'square', durationSec: 30 })
    expect(saved).toMatchObject({ name: 'Weekly tip', emoji: '📋', platform: 'square', durationSec: 30 })
    expect(saved.sections.map((x) => x.label)).toEqual(['Video', 'Hook'])
    expect(s.list()[0].id).toBe(saved.id)
    expect(s.remove(BUILTIN_TEMPLATES[0].id)).toBe(false)
    expect(s.remove(saved.id)).toBe(true)
    expect(s.list().some((t) => t.id === saved.id)).toBe(false)
  })

  it('rejects bad input and survives a corrupt file', () => {
    const s = store()
    expect(() => s.save({ name: '', sections: [{ label: 'Video', hint: '' }] })).toThrow()
    expect(() => s.save({ name: 'x', sections: [] })).toThrow()
    expect(() => s.save({ name: 'x', sections: [{ label: 'Video', hint: '' }], platform: 'myspace' as never })).toThrow()
    const file = join(mkdtempSync(join(tmpdir(), 'tpl-')), 'prompt-templates.json')
    writeFileSync(file, '{not json')
    expect(new PromptTemplateStore(file).list()).toEqual(BUILTIN_TEMPLATES)
  })
})

describe('square videos', () => {
  it('plan and compose at 1080×1080', async () => {
    const { Planner } = await import('../src/main/pipeline/planner')
    const { compose } = await import('../src/main/composer')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'a square post about three tips for better sleep', platform: 'square', styleHint: 'explainer', durationHintSec: 20 })
    expect(spec.platform).toBe('square')
    const { html } = compose(spec, resolve(root, 'vendor'), resolve(root, 'vendor', 'fonts'))
    expect(html).toContain('data-width="1080"')
    expect(html).toContain('data-height="1080"')
    expect(html).not.toContain('undefined')
  })
})
