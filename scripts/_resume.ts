// scratch: resume a project through compose → QA → render with the env-keyed OpenAI provider
import { resolve } from 'node:path'
import { Orchestrator } from '../src/main/pipeline/orchestrator'
import { ProjectStore } from '../src/main/store/projectStore'
import { OpenAIProvider } from '../src/main/providers/openai'
const env = (k: string) => process.env[k] ?? ''
const p = new OpenAIProvider(() => env('OPENAI_API_KEY'), () => env('OPENAI_MODEL') || undefined, () => env('OPENAI_IMAGE_MODEL') || undefined)
const o = new Orchestrator(new ProjectStore(resolve('projects')), () => p, () => p)
const out = await o.resume(process.argv[2], { quality: 'standard', onEvent: (e) => console.log('·', e.stage, (e as { status?: string }).status ?? '') })
console.log('MP4', out)
