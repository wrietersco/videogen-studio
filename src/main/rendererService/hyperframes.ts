import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { appRoot } from '../paths'

/**
 * Render service — wraps the local HyperFrames CLI.
 *  - render():  project dir → MP4 (progress events + cancel support)
 *  - check():   QA pass (lint / runtime / layout / motion / contrast) as JSON
 *
 * PATH is extended with ffmpeg-static/ffprobe-static binaries so the app
 * is self-contained even without a system FFmpeg install.
 */

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
  // ELECTRON_RUN_AS_NODE: inside the app, process.execPath is Electron — this
  // makes it behave as the bundled Node runtime (ignored by plain node/tsx)
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: pathEntries.join(process.platform === 'win32' ? ';' : ':') }
}

/**
 * The HyperFrames CLI runs on this process's own runtime (Electron-as-Node in
 * the app, node under tsx) — installed copies need no system Node.js, and no
 * shell is involved, so arguments with spaces pass through intact.
 */
function hfArgs(): string[] {
  return [resolve(appRoot, 'node_modules/hyperframes/bin/hyperframes.mjs')]
}

function hfBin(): string {
  return process.execPath
}

let browserReady: Promise<boolean> | null = null

/**
 * HyperFrames renders in Chrome: find it or download it once (~150 MB on a
 * fresh install). Memoized; every render/check/snapshot waits for it.
 */
export function ensureBrowser(): Promise<boolean> {
  if (browserReady) return browserReady
  const ready = new Promise<boolean>((resolvePromise) => {
    const child = spawn(hfBin(), [...hfArgs(), 'browser', 'ensure'], { env: toolEnv(), windowsHide: true })
    child.on('error', () => resolvePromise(false))
    child.on('close', (code) => resolvePromise(code === 0))
  }).then((ok) => {
    if (!ok) browserReady = null // retry on the next job
    return ok
  })
  browserReady = ready
  return ready
}

export class RenderService {
  private active = new Map<string, ReturnType<typeof spawn>>()

  async render(
    projectDir: string,
    output: string,
    opts: { fps?: number; quality?: string; gpu?: boolean; onProgress?: (p: RenderProgress) => void },
    jobKey = 'default'
  ): Promise<RenderResult> {
    await ensureBrowser()
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
        windowsHide: true
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

  /**
   * Still frames at exact timeline instants (deterministic software raster) —
   * what the vision critic looks at. Returns PNG paths in the order of `times`.
   */
  async snapshot(projectDir: string, times: number[], outDir: string): Promise<string[]> {
    await ensureBrowser()
    const args = [...hfArgs(), 'snapshot', projectDir, '--at', times.map((t) => t.toFixed(2)).join(','), '--no-end', '-o', outDir, '--no-browser-gpu']
    return new Promise((resolvePromise) => {
      const child = spawn(hfBin(), args, { env: toolEnv(), cwd: projectDir, windowsHide: true })
      child.on('error', () => resolvePromise([]))
      child.on('close', () => {
        try {
          const files = readdirSync(outDir)
            .filter((f) => /^frame-\d+-at-.*\.png$/.test(f))
            .sort()
          resolvePromise(files.map((f) => join(outDir, f)))
        } catch {
          resolvePromise([])
        }
      })
    })
  }

  async check(projectDir: string, opts?: { samples?: number }): Promise<CheckReport> {
    await ensureBrowser()
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
        windowsHide: true
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
        const report = parseCheckOutput(stdout)
        if (report) {
          resolvePromise(report)
          return
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

/** Accept compact and pretty-printed CLI output, with optional log lines. */
export function parseCheckOutput(stdout: string): CheckReport | null {
  const jsonLine = stdout.split('\n').reverse().find(line => line.trim().startsWith('{'))
  const first = stdout.indexOf('{'), last = stdout.lastIndexOf('}')
  for (const candidate of [stdout.trim(), first >= 0 && last >= first ? stdout.slice(first, last + 1) : '', jsonLine]) {
    if (!candidate) continue
    try { return normalizeCheckReport(JSON.parse(candidate)) } catch { /* try next form */ }
  }
  return null
}

/** Defensive normalization — the CLI's JSON shape may evolve. */
export function normalizeCheckReport(json: unknown): CheckReport {
  const j = json as Record<string, unknown>
  // Current HyperFrames emits lint/runtime/layout/etc. directly at the top
  // level; older versions nested them under checks/sections/results.
  const sections = (j.checks ?? j.sections ?? j.results ?? Object.fromEntries(
    Object.entries(j).filter(([, value]) => value !== null && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { findings?: unknown }).findings))
  )) as Record<string, unknown>
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
        fix: (f as { fix?: string; fixHint?: string }).fix ?? (f as { fixHint?: string }).fixHint
      }
      const level = f.level ?? (f as { severity?: string }).severity
      if (level === 'error') errors.push(issue)
      else if (level === 'warning' || level === 'warn') warnings.push(issue)
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
