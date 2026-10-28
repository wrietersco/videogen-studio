import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * In-app updates straight from GitHub Releases: ask the API for the latest
 * published release, download its Windows installer, verify it, then run it
 * silently once the app has quit and reopen the app afterwards.
 */

const REPO = 'wrietersco/videogen-studio'
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const INSTALLER = /^VideoGen-Studio-Setup-.+\.exe$/i

export interface UpdateInfo {
  current: string
  latest: string
  available: boolean
  notes: string
  releaseUrl: string
  name: string
  /** installer download size in bytes (0 if the release has no installer) */
  size: number
  /** true when this build can update itself (installed app, not `npm run dev`) */
  canInstall: boolean
}

interface GhAsset {
  name: string
  size: number
  browser_download_url: string
  digest?: string | null
}

interface GhRelease {
  tag_name: string
  name?: string | null
  body?: string | null
  html_url: string
  draft?: boolean
  prerelease?: boolean
  assets?: GhAsset[]
}

/** 1 if a > b, -1 if a < b, 0 if equal. Ignores a leading "v" and any -prerelease suffix. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

export function pickInstaller(assets: GhAsset[] | undefined): GhAsset | null {
  return assets?.find((a) => INSTALLER.test(a.name)) ?? null
}

let cached: { info: UpdateInfo; asset: GhAsset | null } | null = null

export async function checkForUpdate(): Promise<UpdateInfo> {
  const res = await fetch(LATEST_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VideoGen-Studio-Updater' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(res.status === 403 ? 'GitHub is rate-limiting this PC — try again in a few minutes' : `GitHub answered ${res.status}`)
  const rel = (await res.json()) as GhRelease
  const asset = pickInstaller(rel.assets)
  const current = app.getVersion()
  const latest = rel.tag_name.replace(/^v/i, '')
  const info: UpdateInfo = {
    current,
    latest,
    available: !rel.draft && !rel.prerelease && Boolean(asset) && compareVersions(latest, current) > 0,
    notes: (rel.body ?? '').trim(),
    releaseUrl: rel.html_url,
    name: rel.name?.trim() || `v${latest}`,
    size: asset?.size ?? 0,
    canInstall: app.isPackaged && process.platform === 'win32'
  }
  cached = { info, asset }
  return info
}

const updatesDir = (): string => join(app.getPath('temp'), 'videogen-studio-updates')

/** old installers from earlier updates are dead weight */
function cleanOldDownloads(keep?: string): void {
  const dir = updatesDir()
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir)) if (f !== keep) rmSync(join(dir, f), { force: true })
}

let downloaded: string | null = null

export async function downloadUpdate(onProgress: (done: number, total: number) => void): Promise<string> {
  if (!cached?.asset || !cached.info.available) throw new Error('No update to download — check for updates first')
  const { asset } = cached
  const dir = updatesDir()
  mkdirSync(dir, { recursive: true })
  cleanOldDownloads(asset.name)
  const file = join(dir, asset.name)

  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'VideoGen-Studio-Updater' } })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)

  const hash = createHash('sha256')
  let done = 0
  const body = Readable.fromWeb(res.body as never)
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    done += chunk.length
    onProgress(done, asset.size)
  })
  try {
    await pipeline(body, createWriteStream(file))
  } catch (err) {
    rmSync(file, { force: true })
    throw err
  }

  // integrity: size always, SHA-256 when GitHub publishes a digest for the asset
  const bad = done !== asset.size || (asset.digest?.startsWith('sha256:') && asset.digest.slice(7).toLowerCase() !== hash.digest('hex'))
  if (bad || statSync(file).size !== asset.size) {
    rmSync(file, { force: true })
    throw new Error('The download was corrupted — please try again')
  }
  downloaded = file
  return file
}

/**
 * Runs the downloaded installer silently after this process has exited
 * (the installer cannot replace files that are in use), then reopens the app.
 */
export function installUpdate(): void {
  if (!downloaded || !existsSync(downloaded)) throw new Error('Download the update first')
  const q = (p: string) => `"${p}"`
  // ping = a ~3s delay that works without a console; start "" reopens the app after the install
  const script = `ping -n 4 127.0.0.1 >nul & ${q(downloaded)} /S & start "" ${q(process.execPath)}`
  spawn('cmd.exe', ['/d', '/s', '/c', `"${script}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref()
  app.quit()
}
