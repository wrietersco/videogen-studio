import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * App-root resolution that works in every layout:
 *  - CLI via tsx      → src/main/pipeline/…   (3 levels deep)
 *  - electron-vite dev→ out/main/index.js      (bundled, 2 levels deep)
 *  - packaged app     → inside the asar/app bundle
 * Strategy: walk up from this file until we find the project's package.json.
 */

function findAppRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
      if (pkg.name === 'videogen-studio') return dir
    } catch {
      /* no package.json here — keep walking */
    }
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  // last resort: source-tree relative (CLI dev)
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
}

export const appRoot = findAppRoot()
export const vendorDir = resolve(appRoot, 'vendor')
export const fontsDir = resolve(appRoot, 'vendor', 'fonts')
export const musicDir = resolve(appRoot, 'music')
export const projectsDir = resolve(appRoot, 'projects')
