import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ render: undefined as undefined | ((args: string[], child: any, options: any) => void) }))
vi.mock('node:child_process', () => ({
  spawn: (_bin: string, args: string[], options: any) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    queueMicrotask(() => args.includes('browser') ? child.emit('close', 0) : state.render?.(args, child, options))
    return child
  }
}))
import { RenderService } from '../src/main/rendererService/hyperframes'

it('runs checks without leaving a detached helper that locks the installed app', async () => {
  let ci: string | undefined
  state.render = (_args, child, options) => {
    ci = options.env.CI
    child.stdout.emit('data', Buffer.from('{"ok":true,"errors":[],"warnings":[]}'))
    child.emit('close', 0)
  }
  const report = await new RenderService().check(mkdtempSync(join(tmpdir(), 'render-check-test-')))
  expect(report.ok).toBe(true)
  expect(ci).toBe('1')
})

describe.runIf(process.platform === 'win32')('Windows render publishing', () => {
  it('preserves an existing destination and cleans temporary files when publication fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'render-publish-test-'))
    const destination = join(root, 'existing.mp4')
    mkdirSync(destination)
    writeFileSync(join(destination, 'keep'), 'original')
    let temporary = ''
    state.render = (args, child) => {
      temporary = args[args.indexOf('--output') + 1]
      writeFileSync(temporary, 'new video')
      child.emit('close', 0)
    }
    const result = await new RenderService().render(root, destination, {})
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Could not save rendered video')
    expect(readFileSync(join(destination, 'keep'), 'utf8')).toBe('original')
    expect(existsSync(temporary)).toBe(false)
    expect(readdirSync(root)).toEqual(['existing.mp4'])
  })

  it('does not publish when cancellation races with a successful child exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'render-cancel-test-'))
    const destination = join(root, 'existing.mp4')
    writeFileSync(destination, 'original')
    const service = new RenderService()
    let temporary = ''
    state.render = (args, child) => {
      temporary = args[args.indexOf('--output') + 1]
      writeFileSync(temporary, 'new video')
      service.cancel('job')
      child.emit('close', 0)
    }
    const result = await service.render(root, destination, {}, 'job')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('cancelled')
    expect(readFileSync(destination, 'utf8')).toBe('original')
    expect(existsSync(temporary)).toBe(false)
  })
})
