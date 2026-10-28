/**
 * Vendor setup — copies runtime libs from node_modules into vendor/ and
 * fetches the open fonts the style kits reference into vendor/fonts/.
 * Run once via `npm run setup-vendor`. Compositions reference only local
 * files, so rendering never touches the network (determinism).
 */
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = resolve(root, 'vendor')
mkdirSync(resolve(vendor, 'fonts'), { recursive: true })

// 1. JS libraries
copyFileSync(resolve(root, 'node_modules/gsap/dist/gsap.min.js'), resolve(vendor, 'gsap.min.js'))
console.log('✓ gsap.min.js')

const threeSrc = resolve(root, 'node_modules/three/build/three.module.js')
if (existsSync(threeSrc)) {
  copyFileSync(threeSrc, resolve(vendor, 'three.module.js'))
  console.log('✓ three.module.js')
  // three ≥0.170 splits the build: module.js imports ./three.core.js
  const coreSrc = resolve(root, 'node_modules/three/build/three.core.js')
  if (existsSync(coreSrc)) {
    copyFileSync(coreSrc, resolve(vendor, 'three.core.js'))
    console.log('✓ three.core.js')
  }
} else {
  console.warn('! three.module.js not found (three not installed?)')
}

// 2. Fonts — fontsource via jsDelivr (direct woff2, latin subset)
const FONTS = [
  ['ArchivoBlack-Regular', 'archivo-black', 'latin-400-normal'],
  ['Inter-Regular', 'inter', 'latin-400-normal'],
  ['SpaceGrotesk-Bold', 'space-grotesk', 'latin-700-normal'],
  ['PlayfairDisplay-Bold', 'playfair-display', 'latin-700-normal'],
  ['Nunito-ExtraBold', 'nunito', 'latin-800-normal']
]
for (const [name, family, variant] of FONTS) {
  const dest = resolve(vendor, 'fonts', `${name}.woff2`)
  if (existsSync(dest)) {
    console.log(`• ${name}.woff2 (cached)`)
    continue
  }
  try {
    const res = await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/${family}@latest/${variant}.woff2`)
    if (!res.ok) throw new Error(String(res.status))
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(dest, buf)
    console.log(`✓ ${name}.woff2 (${Math.round(buf.length / 1024)}KB)`)
  } catch (e) {
    console.warn(`! could not fetch ${name}: ${e.message} — compositions will fall back to system fonts`)
  }
}
// 3. Directed-scene fonts — shipped in npm packages (OFL), copied locally
const CRAFT_FONTS = [
  ['Inter-Var', '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'],
  ['BarlowCondensed-ExtraBold', '@fontsource/barlow-condensed/files/barlow-condensed-latin-800-normal.woff2'],
  ['InstrumentSerif-Italic', '@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2'],
  ['JetBrainsMono-Medium', '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2'],
  ['JetBrainsMono-Bold', '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2']
]
for (const [name, pkgPath] of CRAFT_FONTS) {
  const src = resolve(root, 'node_modules', pkgPath)
  if (!existsSync(src)) {
    console.warn(`! ${pkgPath} missing — run npm install`)
    continue
  }
  copyFileSync(src, resolve(vendor, 'fonts', `${name}.woff2`))
  console.log(`✓ ${name}.woff2`)
}
console.log('vendor setup complete')
