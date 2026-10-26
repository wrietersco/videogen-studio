import type { LLMProvider, ProviderId } from './types'
import { MockProvider } from './mock'
import { OpenAIProvider } from './openai'
import { AnthropicProvider } from './anthropic'
import { GeminiProvider } from './gemini'
import type { Settings } from '../settings'

/**
 * Provider registry — resolves which LLMProvider is active and passes
 * stored keys to the real adapters. Model IDs come from listModels() at
 * runtime, so newly released models work without app updates.
 */

export interface ProviderStatus {
  id: ProviderId
  label: string
  configured: boolean
  active: boolean
}

class ProviderRegistry {
  private readonly providers = new Map<ProviderId, LLMProvider>()
  private activeId: ProviderId = 'mock'
  private readonly keys = new Map<ProviderId, string>()
  private readonly models = new Map<ProviderId, string | undefined>()

  constructor() {
    this.providers.set('mock', new MockProvider())
    this.providers.set('openai', new OpenAIProvider(() => this.keys.get('openai') ?? '', () => this.models.get('openai')))
    this.providers.set('anthropic', new AnthropicProvider(() => this.keys.get('anthropic') ?? '', () => this.models.get('anthropic')))
    this.providers.set('gemini', new GeminiProvider(() => this.keys.get('gemini') ?? '', () => this.models.get('gemini')))
  }

  /** True when a key is stored for a provider (mock is always ready). */
  hasKey(id: ProviderId): boolean {
    return id === 'mock' || this.keys.has(id)
  }

  /** Called at startup and whenever settings change. */
  reconfigure(settings: Pick<Settings, 'provider' | 'models'>, keys?: Partial<Record<ProviderId, string>>): void {
    if (settings.provider && this.providers.has(settings.provider)) this.activeId = settings.provider
    if (settings.models) {
      for (const [p, m] of Object.entries(settings.models)) {
        this.models.set(p as ProviderId, m || undefined)
      }
    }
    if (keys) {
      for (const [p, k] of Object.entries(keys)) {
        if (k) this.keys.set(p as ProviderId, k)
      }
    }
  }

  get(id: ProviderId): LLMProvider {
    const p = this.providers.get(id)
    if (!p) throw new Error(`unknown provider ${id}`)
    return p
  }

  active(): LLMProvider {
    return this.get(this.activeId)
  }

  async describe(): Promise<ProviderStatus[]> {
    const out: ProviderStatus[] = []
    for (const [id, p] of this.providers) {
      out.push({
        id,
        label: p.label,
        configured: await p.isConfigured(),
        active: id === this.activeId
      })
    }
    return out
  }
}

export const providerRegistry = new ProviderRegistry()
