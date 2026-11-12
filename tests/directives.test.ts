import { describe, expect, it } from 'vitest'
import { mentionOf, parseDirectives, type PictureView } from '../src/shared/directives'
import { brandSummary, type BrandKit } from '../src/shared/brand'

const pics: PictureView[] = [
  { path: 'D:/a/Dusk Mood.jpg', name: 'Dusk Mood.jpg', role: 'subject' },
  { path: 'D:/a/smart-bottle.png', name: 'smart-bottle.png', role: 'style' },
  { path: 'D:/a/app-screenshot.png', name: 'app-screenshot.png', role: 'subject' }
]
const kit = { hasLogo: true }

describe('mentions', () => {
  it('names a picture by its file name', () => {
    expect(mentionOf('Dusk Mood.jpg')).toBe('dusk-mood')
    expect(mentionOf('smart_bottle (1).PNG')).toBe('smart-bottle-1')
    expect(mentionOf('!!!.png')).toBe('picture')
  })
})

describe('logo directives', () => {
  it('reads the common ways of saying where the logo goes', () => {
    const one = (t: string) => parseDirectives(t, [], kit)
    expect(one('Put the logo at the end.')[0]).toMatchObject({ kind: 'logo', override: { endCard: true } })
    expect(one('Show my logo only at the end')[0]).toMatchObject({ kind: 'logo', override: { watermark: 'off', endCard: true } })
    expect(one('End on the brand')[0]).toMatchObject({ kind: 'logo', override: { endCard: true } })
    expect(one('no logo please')[0]).toMatchObject({ kind: 'logo', override: { watermark: 'off', endCard: false } })
    expect(one('logo in the top left corner')[0]).toMatchObject({ kind: 'logo', override: { watermark: 'top-left' } })
    expect(one('keep the logo on the right')[0]).toMatchObject({ kind: 'logo', override: { watermark: 'top-right' } })
    expect(one('A calm film about hiking')).toEqual([])
  })

  it('says plainly what it cannot do, and never guesses', () => {
    expect(parseDirectives('Start with the logo', [], kit)[0]).toMatchObject({ kind: 'blocked', why: expect.stringMatching(/not available yet/) })
    expect(parseDirectives('logo at the end', [], { hasLogo: false })[0]).toMatchObject({ kind: 'blocked', why: expect.stringMatching(/no logo yet/) })
    expect(parseDirectives('logo at the end', [], null)[0]).toMatchObject({ kind: 'blocked', why: expect.stringMatching(/Pick a brand kit/) })
  })
})

describe('picture directives', () => {
  it('turns "like @name", "@name is the product" and "@name screenshot" into role changes', () => {
    const d = parseDirectives('Make it look like @dusk-mood. Show @smart-bottle as the product, and @3 is the app screen.', pics, kit)
    expect(d.map((x) => (x.kind === 'role' ? `${x.path.split('/').pop()}:${x.role}` : x.kind))).toEqual(['Dusk Mood.jpg:style', 'smart-bottle.png:subject', 'app-screenshot.png:content'])
  })

  it('proposes nothing when the role already matches, or when a mention has no cue', () => {
    expect(parseDirectives('Use @smart-bottle', pics, kit)).toEqual([])
    expect(parseDirectives('the look of @smart-bottle', pics, kit)).toEqual([])
    expect(parseDirectives('as the product: @dusk-mood', pics, kit)).toEqual([])
  })

  it('warns about a mention that matches nothing', () => {
    expect(parseDirectives('like @ghost', pics, kit)[0]).toMatchObject({ kind: 'blocked', label: '@ghost' })
    // an email address is not a mention
    expect(parseDirectives('email me@home.com', pics, kit)).toEqual([])
  })
})

describe('what the card says with an override', () => {
  it('shows the logo placement the person asked for', () => {
    const base: BrandKit = { id: 'k', name: 'K', tagline: 'k.example', colors: { primary: '#0E9F8E', secondary: null }, fonts: { display: null, body: null }, logo: { master: 'a', onDark: 'b', onLight: 'c', width: 10, height: 5, palette: [], notes: [] }, watermark: 'top-right', endCard: true, createdAt: '', updatedAt: '' }
    expect(brandSummary(base).join('|')).toMatch(/top right corner/)
    expect(brandSummary(base, { watermark: 'off' }).join('|')).not.toMatch(/corner/)
    expect(brandSummary(base, { watermark: 'off', endCard: false }).join('|')).not.toMatch(/end card/)
  })
})
