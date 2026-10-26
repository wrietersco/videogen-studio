import type { LLMProvider } from '../providers/types'
import type { CheckIssue } from '../rendererService/hyperframes'

/**
 * CompositionFixer — the LLM-assisted rung of the QA fix loop. When
 * deterministic auto-fixes can't clear a check, the provider gets the
 * composition HTML + the concrete issues and returns a patched document.
 * Always sandboxed: the patch must still pass `check` before it's accepted.
 */

const SYSTEM = `You are a composition repair agent for HyperFrames video projects.
You receive an HTML/CSS/GSAP composition and a list of concrete QA failures.
Return ONLY the complete corrected HTML document — no commentary, no markdown fences.
Repair rules:
- Fix exactly what the issues describe; do not restyle anything else.
- Keep all data-* attributes, ids, and the window.__timelines contract intact.
- Keep text inside the safe area; shorten or wrap text if it overflows.
- Preserve seekability: never add requestAnimationFrame, timers, or autoplay media.`

export class CompositionFixer {
  constructor(private readonly provider: LLMProvider) {}

  async fix(html: string, issues: CheckIssue[]): Promise<string | null> {
    if (issues.length === 0) return null
    const issueText = issues
      .slice(0, 12)
      .map((i, n) => `${n + 1}. [${i.category ?? 'issue'}] ${i.message}${i.selector ? ` (selector: ${i.selector})` : ''}`)
      .join('\n')

    try {
      const patched = await this.provider.generateText({
        system: SYSTEM,
        prompt: `QA issues:\n${issueText}\n\nComposition:\n${html}`,
        temperature: 0.1,
        maxTokens: 32000
      })
      const cleaned = patched.replace(/^```(?:html)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
      // sanity: the patch must still be a composition with the timeline contract
      if (
        !cleaned.startsWith('<!doctype') ||
        !cleaned.includes('data-composition-id') ||
        !cleaned.includes('__timelines')
      ) {
        return null
      }
      return cleaned
    } catch {
      return null // fixer unavailable — loop reports unresolved issues
    }
  }
}
