import type { LLMProvider, ProviderId } from './types'
import { MockProvider } from './mock'
import { OpenAIProvider } from './openai'
import { AnthropicProvider } from './anthropic'
import { GeminiProvider } from './gemini'
import { DeepseekProvider } from './deepseek'
import type { Settings } from '../settings'
import { DEFAULT_ROLES, PROVIDER_CAPABILITIES, type ProviderRole } from '@shared/providerRoles'

/**
 * Provider registry — resolves which LLMProvider runs each role and passes
 * stored keys to the real adapters. Model IDs come from listModels() at
 * runtime, so newly released models work without app updates.
 */

export interface ProviderStatus {
  id: ProviderId
  label: string
  configured: boolean
  active: boolean
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, LLMProvider>()
  private activeId: ProviderId = 'mock'
  private readonly keys = new Map<ProviderId, string>()
  private readonly models = new Map<string, string | undefined>()
  private roles: Partial<Record<ProviderId, ProviderRole[]>> = {}

  constructor() {
    this.providers.set('mock', new MockProvider())
    this.providers.set(
      'openai',
      new OpenAIProvider(
        () => this.keys.get('openai') ?? '',
        () => this.models.get('openai'),
        () => this.models.get('openai-image')
      )
    )
    this.providers.set('anthropic', new AnthropicProvider(() => this.keys.get('anthropic') ?? '', () => this.models.get('anthropic')))
    this.providers.set(
      'gemini',
      new GeminiProvider(() => this.keys.get('gemini') ?? '', () => this.models.get('gemini'), () => this.models.get('gemini-image'))
    )
    this.providers.set('deepseek', new DeepseekProvider(() => this.keys.get('deepseek') ?? '', () => this.models.get('deepseek')))
  }

  /** True when a key is stored for a provider (mock is always ready). */
  hasKey(id: ProviderId): boolean {
    return id === 'mock' || this.keys.has(id)
  }

  /** Called at startup and whenever settings change. */
  reconfigure(settings: Pick<Settings, 'provider' | 'models' | 'roles'>, keys?: Partial<Record<ProviderId, string>>): void {
    if (settings.provider && this.providers.has(settings.provider)) this.activeId = settings.provider
    if (settings.models) {
      for (const [p, m] of Object.entries(settings.models)) {
        this.models.set(p as ProviderId, m || undefined)
      }
    }
    if (settings.roles) this.roles = settings.roles
    if (keys) {
      for (const [p, k] of Object.entries(keys)) {
        if (k) this.keys.set(p as ProviderId, k)
      }
    }
  }

  /** replace every stored key (sign-in / plan changes switch between the plan's relay and the user's own keys) */
  setKeys(keys: Partial<Record<ProviderId, string>>): void {
    this.keys.clear()
    for (const [p, k] of Object.entries(keys)) if (k) this.keys.set(p as ProviderId, k)
  }

  get(id: ProviderId): LLMProvider {
    const p = this.providers.get(id)
    if (!p) throw new Error(`unknown provider ${id}`)
    return p
  }

  active(): LLMProvider {
    return this.get(this.activeId)
  }

  /**
   * Providers that may run `role`, brain provider first, then a fixed order.
   * A provider qualifies when Settings → Who does what enables the role for
   * it, its capability matrix allows the role, and it has a key.
   */
  private candidatesFor(role: ProviderRole): ProviderId[] {
    const order: ProviderId[] = [this.activeId, 'openai', 'anthropic', 'gemini', 'deepseek']
    const seen = new Set<ProviderId>()
    const out: ProviderId[] = []
    for (const id of order) {
      if (id === 'mock' || seen.has(id)) continue
      seen.add(id)
      if (!this.roles[id]?.includes(role)) continue
      if (!PROVIDER_CAPABILITIES[id].includes(role)) continue
      if (!this.keys.has(id)) continue
      out.push(id)
    }
    return out
  }

  /**
   * The provider a role runs on (writing, code, vision): the first candidate
   * above. Null → the caller keeps its fallback (the brain provider).
   */
  forRole(role: ProviderRole): LLMProvider | null {
    for (const id of this.candidatesFor(role)) {
      const p = this.providers.get(id)
      if (role === 'image-gen' && !p?.generateImage) continue
      return p ?? null
    }
    return null
  }

  /**
   * boolean gate for services outside this registry (ElevenLabs voices,
   * Whisper transcription, Gemini clips). Ids with no role config at all
   * (ElevenLabs, stock keys) are always allowed — their own key checks
   * decide; a cleared chat provider counts as configured-empty, i.e. off.
   */
  roleEnabled(id: string, role: ProviderRole): boolean {
    const list = this.roles[id as ProviderId]
    if (!list) return !(id in DEFAULT_ROLES)
    return list.includes(role) && (PROVIDER_CAPABILITIES[id as ProviderId]?.includes(role) ?? true)
  }

  /**
   * Painted plates need an image model, independent of the chat provider:
   * the providers enabled for image generation, else null (dot-grid scenes).
   */
  imageProvider(): LLMProvider | null {
    return this.forRole('image-gen')
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
