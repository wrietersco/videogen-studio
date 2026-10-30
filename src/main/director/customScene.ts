import { parseDocument } from 'htmlparser2'
import type { LLMProvider } from '../providers/types'
import type { VideoSpec } from '@shared/spec'

const tags = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath'])
const attrs = new Set(['xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'transform', 'id', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'clip-path', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'letter-spacing'])
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Strict allowlist: generated code is an inert SVG image, never browser script or an external resource. */
export function validateSceneSvg(input: string): string {
  if (input.length > 100000 || /<!|<\?/i.test(input)) throw new Error('Invalid SVG document')
  const doc = parseDocument(input, { xmlMode: true, decodeEntities: true })
  let count = 0
  const render = (node: any): string => {
    if (node.type === 'text') return esc(node.data ?? '')
    if (node.type !== 'tag' || !tags.has(node.name) || ++count > 300) throw new Error('Unsupported SVG element')
    const fields = Object.entries(node.attribs as Record<string, string>).map(([key, value]) => {
      if (key === 'xmlns' && value !== 'http://www.w3.org/2000/svg') throw new Error('Unsupported SVG namespace')
      if (key === 'id' && !/^[A-Za-z][\w.-]*$/.test(value)) throw new Error('Invalid SVG id')
      if (!attrs.has(key) || value.length > 10000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) || (key !== 'xmlns' && /(?:javascript:|data:|https?:|file:|@import|expression\s*\()/i.test(value))) throw new Error('Unsupported SVG attribute')
      if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z][\w.-]*\)$/.test(value)) throw new Error('External SVG reference')
      return ` ${key}="${esc(value)}"`
    }).join('')
    return `<${node.name}${fields}>${(node.children ?? []).map(render).join('')}</${node.name}>`
  }
  const roots = doc.children.filter((n: any) => n.type !== 'text' || n.data.trim())
  if (roots.length !== 1 || (roots[0] as any).name !== 'svg') throw new Error('Expected one SVG root')
  const result = render(roots[0])
  if (!/\bviewBox\s*=/.test(result)) throw new Error('SVG needs a viewBox')
  return result
}

const selectionSchema = { type: 'object', properties: { sceneIds: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['sceneIds', 'reason'], additionalProperties: false }

/** Let the selected model identify scenes that benefit from bespoke vector code. */
export async function chooseCustomScenes(provider: LLMProvider, spec: VideoSpec, prompt: string): Promise<string[]> {
  if (provider.id === 'mock') return []
  try {
    const r = await provider.generateJSON<{ sceneIds: string[]; reason: string }>({
      system: 'You are a video director. Identify scenes where bespoke code is genuinely useful to explain an abstract concept, make a custom diagram, or create an original 2D animation or simulation. When the brief explicitly requests a custom illustration, diagram or coded animation, choose the relevant scene. Prefer real footage or photographs for real people, places, objects and physical processes; do not replace suitable footage just for decoration. Code can generate vector art or an animated 2D canvas, not 3D or generated footage. Return only scene IDs from the supplied storyboard. Return an empty list if none needs bespoke code.',
      prompt: JSON.stringify({ brief: prompt, scenes: spec.scenes, narration: spec.narration, existingVisuals: spec.crafts.map(c => ({ sceneId: c.sceneId, background: c.background, hasClip: Boolean(c.plate?.clipFile) })) }),
      schemaName: 'CustomSceneSelection', jsonSchema: selectionSchema, temperature: 0.2, maxTokens: 500
    })
    const valid = new Set(spec.scenes.map(s => s.id))
    return [...new Set(Array.isArray(r.sceneIds) ? r.sceneIds.filter(id => valid.has(id)) : [])]
  } catch { return [] }
}

/** The model writes original SVG source for a particular scene and can repair it using review feedback. */
export async function authorCustomScene(provider: LLMProvider, spec: VideoSpec, prompt: string, sceneId: string, feedback?: string, previousSvg?: string, continuityFrame?: Buffer): Promise<string> {
  const scene = spec.scenes.find(s => s.id === sceneId)
  if (!scene) throw new Error('Unknown scene')
  const request = {
    system: 'Write one original SVG scene as source code for a professional video. Return only an SVG element with a viewBox. Make it visually specific to the scene and coherent with the film. If an image of the preceding approved scene is supplied, preserve the identity and design of recurring characters, emblems and products. Use strong hierarchy and composition; avoid template dashboards, long text, and illegible type. Keep all important content inside 90% of the frame. Group up to six successive visual actions in <g id="motion1">, <g id="motion2"> and so on, in narrative order; the renderer will reveal those groups over the scene. Keep the background and static context outside those groups. Supported elements: svg, g, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, defs, linearGradient, radialGradient, stop, clipPath. No script, external resources, links, CSS, foreignObject, image or animation elements. Use only explicit SVG attributes.',
    prompt: JSON.stringify({ brief: prompt, scene, narration: spec.narration.find(n => n.sceneId === sceneId)?.text, palette: spec.palette, platform: spec.platform, feedback, previousSvg }),
    images: continuityFrame ? [{ mimeType: 'image/jpeg', base64: continuityFrame.toString('base64') }] : undefined,
    temperature: 0.6, maxTokens: 6000
  }
  let raw: string
  try { raw = await provider.generateText(request) } catch (err) {
    if (!continuityFrame) throw err
    raw = await provider.generateText({ ...request, images: undefined })
  }
  return validateSceneSvg(raw.replace(/^```(?:svg|xml)?\s*/i, '').replace(/\s*```\s*$/, '').trim())
}
