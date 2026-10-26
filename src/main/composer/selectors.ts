import type { AnimStep } from './anim'
import type { CheckIssue } from '../rendererService/hyperframes'

/**
 * Composition-level self-checks that run BEFORE any HyperFrames session —
 * cheap, deterministic, and they catch the most common failure class
 * (GSAP steps pointing at elements that don't exist) instantly.
 */

export function validateSelectors(html: string, steps: AnimStep[]): CheckIssue[] {
  const issues: CheckIssue[] = []
  const ids = new Set<string>([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
  const classes = new Set<string>([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))

  for (const step of steps) {
    const sel = (step as { sel?: string }).sel
    if (!sel) continue
    // id selectors (incl. descendants like "#s ul li:nth-child(2)")
    const idMatches = [...sel.matchAll(/#([A-Za-z0-9_-]+)/g)]
    for (const m of idMatches) {
      if (!ids.has(m[1])) {
        issues.push({
          category: 'Selector',
          message: `animation step targets missing element #${m[1]}`,
          selector: sel
        })
        break
      }
    }
    // bare class selectors like ".atmo-progress-fill"
    if (!sel.startsWith('#')) {
      const cls = sel.replace(/^\./, '').split(/[^A-Za-z0-9_-]/)[0]
      if (sel.startsWith('.') && cls && !classes.has(cls)) {
        issues.push({ category: 'Selector', message: `animation step targets missing class .${cls}`, selector: sel })
      }
    }
    // li:nth-child(n) sanity: compare against list item counts
    for (const m of sel.matchAll(/li:nth-child\((\d+)\)/g)) {
      const n = Number(m[1])
      const baseSel = sel.slice(0, m.index ?? 0)
      const baseId = baseSel.match(/#([A-Za-z0-9_-]+)/)?.[1]
      if (!baseId) continue
      const listMatch = html.match(new RegExp(`id="${baseId}"[\\s\\S]*?<ul[^>]*>([\\s\\S]*?)</ul>`))
      if (!listMatch) continue
      const itemCount = (listMatch[1].match(/<li/g) ?? []).length
      if (n > itemCount) {
        issues.push({
          category: 'Selector',
          message: `stagger step targets li:nth-child(${n}) but list has ${itemCount} items`,
          selector: sel
        })
      }
    }
  }
  return issues
}
