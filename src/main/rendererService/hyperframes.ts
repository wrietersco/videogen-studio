import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Render service — wraps the local HyperFrames CLI.
 *  - render():  project dir → MP4 (progress events + cancel support)
 *  - check():   QA pass (lint / runtime / layout / motion / contrast) as JSON
 *
 * PATH is extended with ffmpeg-static/ffprobe-static binaries so the app
 * is self-contained even without a system FFmpeg install.
 */

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export interface RenderProgress {
  pct: number
  code?: string
  done?: number
  total?: number
}

export interface RenderResult {
  ok: boolean
  output?: string
  error?: string
  durationSec?: number
}

function toolEnv(): NodeJS.ProcessEnv {
  const pathEntries = [
    resolve(appRoot, 'node_modules/ffmpeg-static'),
    resolve(appRoot, 'node_modules/ffprobe-static/bin/win32/x64'),
    process.env.PATH ?? ''
  ]
  return { ...process.env, PATH: pathEntries.join(process.platform === 'win32' ? ';' : ':') }
}

function hfArgs(): string[] {
  // run the locally installed hyperframes CLI
  return []
}

function hfBin(): string {
  const local = resolve(appRoot, 'node_modules/.bin/hyperframes.cmd')
  if (existsSync(local)) return local
  return 'hyperframes'
}

export class RenderService {
  private active = new Map<string, ReturnType<typeof spawn>>()

  render(
    projectDir: string,
    output: string,
    opts: { fps?: number; quality?: string; gpu?: boolean; onProgress?: (p: RenderProgress) => void },
    jobKey = 'default'
  ): Promise<RenderResult> {
    // Determinism strategy (measured empirically):
    //  - Chrome's GPU rasterization varies run-to-run  -> --no-browser-gpu default
    //  - multi-worker capture varies text antialiasing  -> single worker for
    //    standard/delivery (byte-stable re-renders), parallel workers only for drafts
    const quality = opts.quality ?? 'standard'
    const args = [
      ...hfArgs(),
      'render',
      projectDir,
      '--output',
      output,
      '--quiet',
      ...(opts.gpu ? [] : ['--no-browser-gpu']),
      ...(quality === 'draft' ? ['--workers', 'auto'] : ['--workers', '1']),
      ...(opts.fps ? ['--fps', String(opts.fps)] : []),
      ...(opts.quality ? ['--quality', quality] : [])
    ]
    return new Promise((resolvePromise) => {
      const started = Date.now()
      const child = spawn(hfBin(), args, {
        env: toolEnv(),
        cwd: projectDir,
        windowsHide: true,
        shell: process.platform === 'win32'
      })
      this.active.set(jobKey, child)

      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          const m = line.match(/@hf-progress\s+(\{.*\})/)
          if (m) {
            try {
              const j = JSON.parse(m[1]) as { pct?: number; code?: string; done?: number; total?: number }
              opts.onProgress?.({ pct: j.pct ?? 0, code: j.code, done: j.done, total: j.total })
            } catch {
              /* ignore malformed progress lines */
            }
          }
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (err) => {
        this.active.delete(jobKey)
        resolvePromise({ ok: false, error: `render spawn failed: ${err.message}` })
      })
      child.on('close', (code) => {
        this.active.delete(jobKey)
        const durationSec = (Date.now() - started) / 1000
        if (code === 0 && existsSync(output)) {
          resolvePromise({ ok: true, output, durationSec })
        } else {
          resolvePromise({ ok: false, error: stderr.slice(-2000) || `render exited ${code}` , durationSec })
        }
      })
    })
  }

  cancel(jobKey = 'default'): void {
    const child = this.active.get(jobKey)
    if (child) child.kill()
  }

  async check(projectDir: string, opts?: { samples?: number }): Promise<CheckReport> {
    const args = [
      ...hfArgs(),
      'check',
      projectDir,
      '--json',
      '--max-issues',
      '60',
      ...(opts?.samples ? ['--samples', String(opts.samples)] : [])
    ]
    return new Promise((resolvePromise) => {
      const child = spawn(hfBin(), args, {
        env: toolEnv(),
        cwd: projectDir,
        windowsHide: true,
        shell: process.platform === 'win32'
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()))
      child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
      child.on('error', (err) =>
        resolvePromise({
          ok: false,
          errors: [{ message: `check spawn failed: ${err.message}` }],
          warnings: [],
          raw: stderr
        })
      )
      child.on('close', (code) => {
        const jsonLine = stdout
          .split('\n')
          .reverse()
          .find((l) => l.trim().startsWith('{'))
        if (jsonLine) {
          try {
            resolvePromise(normalizeCheckReport(JSON.parse(jsonLine)))
            return
          } catch {
            /* fall through */
          }
        }
        // non-JSON fallback: parse the human summary
        const errors: CheckIssue[] = []
        const warnings: CheckIssue[] = []
        const summary = stdout.match(/(\d+) error\(s\), (\d+) warning\(s\)/)
        if (summary) {
          const m = stdout.matchAll(/(Layout|Motion|Runtime|Contrast|Craft)\s*\n?\s*✗?\s*(.+)/g)
          for (const g of m) errors.push({ category: g[1], message: g[2] })
        }
        resolvePromise({
          ok: code === 0 && errors.length === 0,
          errors,
          warnings,
          raw: `${stdout}\n${stderr}`.slice(-4000)
        })
      })
    })
  }
}

export interface CheckIssue {
  category?: string
  message: string
  selector?: string
  fix?: string
}

export interface CheckReport {
  ok: boolean
  errors: CheckIssue[]
  warnings: CheckIssue[]
  raw?: string
}

/** Defensive normalization — the CLI's JSON shape may evolve. */
function normalizeCheckReport(json: unknown): CheckReport {
  const j = json as Record<string, unknown>
  const sections = (j.checks ?? j.sections ?? j.results ?? {}) as Record<string, unknown>
  const errors: CheckIssue[] = []
  const warnings: CheckIssue[] = []
  for (const [category, v] of Object.entries(sections)) {
    const sv = v as { errors?: unknown[]; warnings?: unknown[]; findings?: Array<{ level?: string; message?: string }> }
    for (const e of sv.errors ?? []) errors.push({ category, message: issueText(e) })
    for (const w of sv.warnings ?? []) warnings.push({ category, message: issueText(w) })
    for (const f of sv.findings ?? []) {
      const issue: CheckIssue = {
        category,
        message: f.message ?? JSON.stringify(f),
        selector: (f as { selector?: string }).selector,
        fix: (f as { fix?: string }).fix
      }
      if (f.level === 'error') errors.push(issue)
      else warnings.push(issue)
    }
  }
  // top-level shapes
  if (Array.isArray(j.errors)) for (const e of j.errors) errors.push({ message: issueText(e) })
  if (Array.isArray(j.warnings)) for (const w of j.warnings) warnings.push({ message: issueText(w) })
  const passed = j.ok ?? j.passed ?? (typeof j.passed === 'boolean' ? j.passed : undefined)
  return { ok: (passed as boolean | undefined) ?? errors.length === 0, errors, warnings, raw: JSON.stringify(json).slice(0, 6000) }
}

function issueText(e: unknown): string {
  if (typeof e === 'string') return e
  const o = e as { message?: string; text?: string; description?: string }
  return o.message ?? o.text ?? o.description ?? JSON.stringify(e)
}

export function readCheckArtifact(projectDir: string): unknown | null {
  const dir = join(projectDir, '.hyperframes', 'artifacts', 'checks')
  if (!existsSync(dir)) return null
  try {
    const files = readdirSync(dir)
    const latest = files.sort().at(-1)
    return latest ? JSON.parse(readFileSync(join(dir, latest), 'utf8')) : null
  } catch {
    return null
  }
}
