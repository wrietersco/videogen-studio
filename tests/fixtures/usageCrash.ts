import { meter } from '../../src/main/usage/meter'

const [aDir, bDir] = process.argv.slice(2)
const a = meter.open('generate'), b = meter.open('generate')
await Promise.all([
  meter.scope(a, async () => {
    meter.record({ kind: 'text', provider: 'openai', model: 'gpt-6-luna', usage: { inputTokens: 1e6, outputTokens: 1e6 } })
    meter.bindProject(aDir)
    await new Promise(resolve => setTimeout(resolve, 20))
    meter.record({ kind: 'image', provider: 'gemini', model: 'gemini-3-pro-image', usage: { images: 1 } })
  }),
  meter.scope(b, async () => {
    meter.bindProject(bDir)
    meter.record({ kind: 'text', provider: 'openai', model: 'gpt-6-luna', usage: { inputTokens: 1e6, outputTokens: 1e6 } })
  })
])
// No close or finally handler: simulate an abrupt process exit.
process.exit(19)
