import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { PlatformId, StyleFamily } from '../../shared/spec'
import { BUILTIN_TEMPLATES, type PromptTemplate } from '../../shared/promptTemplates'

/** Saved prompt structures: the built-in starters plus the person's own, in one JSON file. */

const TemplateInput = z.object({
  name: z.string().trim().min(1).max(60),
  emoji: z.string().trim().max(8).optional(),
  sections: z.array(z.object({ label: z.string().trim().min(1).max(40), hint: z.string().trim().max(200) })).min(1).max(16),
  platform: PlatformId.optional(),
  style: StyleFamily.optional(),
  durationSec: z.number().int().min(5).max(300).optional()
})
export type TemplateInput = z.input<typeof TemplateInput>

export class PromptTemplateStore {
  constructor(private readonly file: string) {}

  private readOwn(): PromptTemplate[] {
    if (!existsSync(this.file)) return []
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return Array.isArray(raw) ? (raw as PromptTemplate[]).filter((t) => t && typeof t.id === 'string' && Array.isArray(t.sections)) : []
    } catch {
      return [] // corrupt file: start fresh rather than block Create
    }
  }

  private writeOwn(list: PromptTemplate[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(list, null, 2))
  }

  /** newest of the person's own first, then the starters */
  list(): PromptTemplate[] {
    return [...this.readOwn().reverse(), ...BUILTIN_TEMPLATES]
  }

  save(input: TemplateInput): PromptTemplate {
    const t = TemplateInput.parse(input)
    const own = this.readOwn()
    const template: PromptTemplate = {
      id: `tpl-${randomUUID().slice(0, 8)}`,
      name: t.name,
      emoji: t.emoji || '📋',
      sections: t.sections.filter((s, i, all) => all.findIndex((o) => o.label.toLowerCase() === s.label.toLowerCase()) === i),
      ...(t.platform ? { platform: t.platform } : {}),
      ...(t.style ? { style: t.style } : {}),
      ...(t.durationSec ? { durationSec: t.durationSec } : {}),
      createdAt: new Date().toISOString()
    }
    this.writeOwn([...own, template])
    return template
  }

  remove(id: string): boolean {
    const own = this.readOwn()
    const next = own.filter((t) => t.id !== id)
    if (next.length === own.length) return false
    this.writeOwn(next)
    return true
  }
}
