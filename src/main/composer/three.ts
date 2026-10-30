import type { Scene } from '@shared/spec'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { appRoot } from '../paths'

/**
 * Three.js composition scripts — generated as self-contained module script
 * text embedded in the composition HTML. Determinism rules:
 *   - no requestAnimationFrame, no wall-clock: every frame is an analytic
 *     function of timeline time t (HyperFrames seeks the timeline + screenshots)
 *   - seeded PRNG for any randomness (particle placement)
 *   - init once on load; register an update handler in window.__render3d
 */

type ShowcaseSpec = Extract<Scene, { kind: 'showcase3d' }>
type ParticlesSpec = Extract<Scene, { kind: 'particles' }>

function mulberry32(): string {
  return `
  function mulberry32(a) {
    return function() {
      a |= 0; a = (a + 0x6D2B79F5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }`
}

// Segment counts tuned for CPU (SwiftShader) rendering — still smooth at 1080p,
// several× cheaper than defaults, so the deterministic software path stays viable.
const GEOMETRY_SNIPPETS: Record<ShowcaseSpec['objectStyle'], string> = {
  torusknot: `new THREE.TorusKnotGeometry(1.05, 0.34, 120, 20)`,
  icosphere: `new THREE.IcosahedronGeometry(1.35, 2)`,
  crystal: `new THREE.OctahedronGeometry(1.5, 0)`,
  productBox: `new THREE.BoxGeometry(1.7, 2.4, 0.42, 2, 2, 2)`,
  logoText: `new THREE.TorusKnotGeometry(1.15, 0.16, 140, 16, 2, 3)`,
  sphereGrid: `new THREE.IcosahedronGeometry(1.45, 2)`
}

let cachedFont: { raw: string; glyphs: Record<string, unknown> } | null | undefined
function logoFont(): { raw: string; glyphs: Record<string, unknown> } | null {
  if (cachedFont !== undefined) return cachedFont
  try {
    const raw = readFileSync(resolve(appRoot, 'node_modules/three/examples/fonts/helvetiker_bold.typeface.json'), 'utf8')
    const parsed = JSON.parse(raw) as { glyphs: Record<string, unknown> }
    return (cachedFont = { raw: JSON.stringify(parsed).replace(/</g, '\\u003c'), glyphs: parsed.glyphs })
  } catch { return (cachedFont = null) }
}

export function supportsExtrudedLogo(text?: string): boolean {
  const font = logoFont()
  return Boolean(text?.trim() && font && [...text].every((character) => Boolean(font.glyphs[character])))
}

function materialSnippet(material: ShowcaseSpec['material'], accentHex: string, accent2Hex: string): string {
  switch (material) {
    case 'chrome':
      return `new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1.0, roughness: 0.1, envMapIntensity: 1.5 })`
    case 'glass':
      // no `transmission`: it forces a second scene render pass — brutally slow
      // under software WebGL. Clearcoat + opacity reads as glass at a fraction of the cost.
      return `new THREE.MeshPhysicalMaterial({ color: 0xf8fbff, metalness: 0.1, roughness: 0.06, clearcoat: 1.0, clearcoatRoughness: 0.06, transparent: true, opacity: 0.55, envMapIntensity: 1.8 })`
    case 'matte':
      return `new THREE.MeshStandardMaterial({ color: ${accentHex}, metalness: 0.05, roughness: 0.7, envMapIntensity: 0.6 })`
    case 'neon':
      return `new THREE.MeshStandardMaterial({ color: ${accentHex}, emissive: ${accentHex}, emissiveIntensity: 1.35, metalness: 0.3, roughness: 0.35, envMapIntensity: 1.0 })`
    case 'iridescent':
      return `new THREE.MeshPhysicalMaterial({ color: ${accent2Hex}, metalness: 0.55, roughness: 0.18, iridescence: 1.0, iridescenceIOR: 1.6, envMapIntensity: 1.3 })`
    default:
      throw new Error(`unknown material: ${material as string}`)
  }
}

function motionSnippet(motion: ShowcaseSpec['motion']): string {
  switch (motion) {
    case 'spin':
      return `
      mesh.rotation.y = t * 0.9
      mesh.rotation.x = Math.sin(t * 0.4) * 0.12
      camera.position.set(0, 0.05, 4.4)`
    case 'float':
      return `
      mesh.rotation.y = t * 0.45
      mesh.position.y = Math.sin(t * 1.05) * 0.22
      camera.position.set(0, 0.0, 4.4)`
    case 'dollyOrbit': {
      return `
      const a = -0.6 + t * 0.42
      const r = 4.9 - Math.sin(t * 0.35) * 0.55
      camera.position.set(Math.sin(a) * r, -0.5 + Math.sin(t * 0.22) * 0.35, Math.cos(a) * r)
      mesh.rotation.y = t * 0.28`
    }
    case 'explodeAssemble': {
      return `
      const k = 0.5 + 0.5 * Math.sin(t * 0.85 - Math.PI / 2)   // 0 → assembled, 1 → exploded
      mesh.rotation.y = t * 0.3
      mesh.position.y = 0
      shell.scale.setScalar(1 + k * 0.32)
      shell.material.opacity = 0.06 + k * 0.14
      shards.forEach((s, i) => {
        const dir = shardDirs[i]
        s.position.copy(dir).multiplyScalar(k * 1.3)
        s.rotation.x = t * (0.7 + i * 0.2)
        s.rotation.y = t * (0.5 + i * 0.3)
      })
      camera.position.set(0, 0.0, 5.0)`
    }
    default:
      throw new Error(`unknown motion: ${motion as string}`)
  }
}

export function buildThreeShowcase(
  hostSelector: string,
  objectStyle: ShowcaseSpec['objectStyle'],
  material: ShowcaseSpec['material'],
  motion: ShowcaseSpec['motion'],
  durSec: number,
  sceneId: string,
  seed: number,
  accent: string,
  accent2: string,
  logoText?: string
): string {
  const accentHex = hexToLiteral(accent)
  const accent2Hex = hexToLiteral(accent2)
  const needsShards = motion === 'explodeAssemble'
  const needsShell = objectStyle === 'sphereGrid'
  let fontData = ''
  let extrudedText = ''
  if (objectStyle === 'logoText' && supportsExtrudedLogo(logoText)) {
    fontData = logoFont()!.raw
    extrudedText = logoText!
  }
  return `<script type="module">
  import * as THREE from './assets/vendor/three.module.js'
  ${extrudedText ? "import { FontLoader } from './assets/vendor/FontLoader.js'; import { TextGeometry } from './assets/vendor/TextGeometry.js'" : ''}
  const SCENE_ID = '${sceneId}'
  ${mulberry32()}
  ;(() => {
    const host = document.querySelector('${hostSelector}')
    if (!host) return
    const W = host.clientWidth || 1080
    const H = host.clientHeight || 1080
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setSize(W, H)
    renderer.setPixelRatio(1)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15
    host.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    // depth cue: distant geometry falls into the dark instead of floating on black
    scene.fog = new THREE.FogExp2(0x07070c, 0.024)
    const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 100)
    camera.position.set(0, 0.3, 4.6)

    // procedural studio environment (deterministic): soft key + tinted rims
    // painted on a canvas → PMREM. This is what metal reflects — a flat dark
    // env is why chrome used to read as mud.
    const envCanvas = document.createElement('canvas')
    envCanvas.width = 512; envCanvas.height = 256
    const g = envCanvas.getContext('2d')
    const base = g.createLinearGradient(0, 0, 0, 256)
    base.addColorStop(0, '#34394f'); base.addColorStop(0.55, '#171824'); base.addColorStop(1, '#07070c')
    g.fillStyle = base; g.fillRect(0, 0, 512, 256)
    const blob = (x, y, r, color, a) => {
      const rg = g.createRadialGradient(x, y, r * 0.05, x, y, r)
      rg.addColorStop(0, color.replace('A', String(a))); rg.addColorStop(1, color.replace('A', '0'))
      g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2)
    }
    blob(120, 62, 130, 'rgba(255,255,255,A)', 0.95)   // softbox key
    blob(396, 96, 110, '${accent}', 0.85)             // accent kicker
    blob(58, 190, 100, 'rgba(150,200,255,A)', 0.55)   // cool rim
    blob(300, 210, 120, '${accent}', 0.30)            // ground bounce tint
    const envTex = new THREE.CanvasTexture(envCanvas)
    envTex.mapping = THREE.EquirectangularReflectionMapping
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromEquirectangular(envTex).texture

    const key = new THREE.DirectionalLight(0xffffff, 1.9)
    key.position.set(3, 5, 4)
    scene.add(key)
    const rim = new THREE.DirectionalLight(${accent2Hex}, 2.2)
    rim.position.set(-4, -1, -3)
    scene.add(rim)
    scene.add(new THREE.HemisphereLight(0x8a93b8, 0x0a0a12, 0.5))

    // seeded starfield behind the hero — depth instead of empty black
    const starRand = mulberry32(${seed} * 31337 + 5)
    const SN = 650
    const starPos = new Float32Array(SN * 3)
    for (let i = 0; i < SN; i++) {
      const r = 7 + starRand() * 7
      const theta = starRand() * Math.PI * 2
      const phi = Math.acos(2 * starRand() - 1)
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      starPos[i * 3 + 2] = r * Math.cos(phi)
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xdfe6ff, size: 0.045, transparent: true, opacity: 0.7, depthWrite: false
    }))
    scene.add(stars)

    // the hero object sits in the lower half of the frame — text owns the top
    const rig = new THREE.Group()
    rig.position.y = -0.5
    // Portrait cameras have a narrow horizontal field of view. Scale the
    // non-logo rig to fit rather than letting a rotating object fill and crop
    // the entire frame. The extruded logo is fitted separately below.
    ${extrudedText ? '' : 'rig.scale.setScalar(Math.min(1, (W / H) * 0.95))'}
    scene.add(rig)

    ${extrudedText ? `
    const font = new FontLoader().parse(${fontData})
    const geometry = new TextGeometry(${JSON.stringify(extrudedText).replace(/</g, '\\u003c')}, { font, size: 0.8, depth: 0.18, curveSegments: 5, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.015, bevelSegments: 2 })
    geometry.computeBoundingBox()
    const bounds = geometry.boundingBox
    const geometryWidth = Math.max(0.01, bounds.max.x - bounds.min.x)
    geometry.center()
    // Fit the wordmark to the narrowest part of the camera's view, including
    // portrait canvases and camera moves, with room for the safety margins.
    const safeWidth = 2 * Math.tan(THREE.MathUtils.degToRad(20)) * 3.6 * (W / H) * 0.8
    const logoScale = Math.min(1, safeWidth / geometryWidth)
    geometry.scale(logoScale, logoScale, logoScale)
    ` : `const geometry = ${GEOMETRY_SNIPPETS[objectStyle]}`}
    const mat = ${materialSnippet(material, accentHex, accent2Hex)}
    const mesh = new THREE.Mesh(geometry, mat)
    rig.add(mesh)
    ${objectStyle === 'crystal' || objectStyle === 'productBox' ? `
    // precision edge overlay — reads as deliberate product/CAD design
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 18),
      new THREE.LineBasicMaterial({ color: ${accent2Hex}, transparent: true, opacity: 0.4 })
    )
    mesh.add(edges)` : ''}
    // tilted orbit ring — an art-directed accent circling the hero
    const orbit = new THREE.Mesh(
      new THREE.TorusGeometry(1.95, 0.012, 8, 128),
      new THREE.MeshBasicMaterial({ color: ${accent2Hex}, transparent: true, opacity: 0.55 })
    )
    orbit.rotation.x = 1.32
    ${extrudedText ? 'orbit.scale.setScalar(Math.min(1, (W / H) * 0.95))' : ''}
    rig.add(orbit)
    ${needsShell ? `
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.56, 1),
      new THREE.MeshBasicMaterial({ color: ${accent2Hex}, wireframe: true, transparent: true, opacity: 0.1 })
    )
    rig.add(shell)` : `const shell = new THREE.Group(); shell.material = { opacity: 0 }; rig.add(shell)`}
    ${needsShards ? `
    const rand = mulberry32(${seed} * 7919 + 13)
    const shardDirs = [0, 1, 2, 3].map(() => {
      const v = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1)
      return v.normalize()
    })
    const shards = shardDirs.map(() => {
      const s = new THREE.Mesh(new THREE.TetrahedronGeometry(0.17), mat)
      rig.add(s)
      return s
    })` : 'const shards = []; const shardDirs = []'}

    const START = Number(window.__sceneStart?.[SCENE_ID] ?? 0)
    const DUR = ${durSec.toFixed(2)}
    function update(globalT) {
      if (globalT < START || globalT > START + DUR) return
      const t = Math.min(Math.max(globalT - START, 0), DUR)
      stars.rotation.y = t * 0.02
      orbit.rotation.z = t * 0.22
      ${motionSnippet(motion)}
      ${extrudedText ? `
      // A logo reveal must land readable: settle the wordmark front-on and
      // clear transient shards before the final hold.
      const settle = THREE.MathUtils.smoothstep(t, DUR * 0.45, DUR * 0.8)
      mesh.rotation.y *= 1 - settle
      shards.forEach((s) => { s.visible = t < DUR * 0.55 })
      ` : ''}
      camera.lookAt(0, -0.5, 0)
      renderer.render(scene, camera)
    }
    window.addEventListener('hf-seek', (e) => update(e.detail.time))
    update(START)
  })()
  </script>`
}

export function buildThreeParticles(
  hostSelector: string,
  density: ParticlesSpec['density'],
  durSec: number,
  sceneId: string,
  seed: number,
  accent: string,
  accent2: string
): string {
  const n = density === 'sparse' ? 700 : density === 'dense' ? 2600 : 1500
  return `<script type="module">
  import * as THREE from './assets/vendor/three.module.js'
  const SCENE_ID = '${sceneId}'
  ${mulberry32()}
  ;(() => {
    const host = document.querySelector('${hostSelector}')
    if (!host) return
    const W = host.clientWidth || 1080
    const H = host.clientHeight || 1080
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setSize(W, H)
    renderer.setPixelRatio(1)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15
    host.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100)
    camera.position.z = 6

    const rand = mulberry32(${seed} * 104729 + 7)
    const N = ${n}
    const pos = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      // shell placement between r=1.2 and r=5
      const r = 1.2 + rand() * 3.8
      const theta = rand() * Math.PI * 2
      const phi = Math.acos(2 * rand() - 1)
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.72
      pos[i * 3 + 2] = r * Math.cos(phi) * 0.6
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const mat = new THREE.PointsMaterial({
      color: ${hexToLiteral(accent2)},
      size: 0.028,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
    const points = new THREE.Points(geo, mat)
    scene.add(points)

    // far dust layer — parallax depth behind the main field
    const N2 = Math.round(${n} * 0.45)
    const pos2 = new Float32Array(N2 * 3)
    for (let i = 0; i < N2; i++) {
      const r = 5.2 + rand() * 3.6
      const theta = rand() * Math.PI * 2
      const phi = Math.acos(2 * rand() - 1)
      pos2[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      pos2[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.72
      pos2[i * 3 + 2] = r * Math.cos(phi) * 0.6
    }
    const geo2 = new THREE.BufferGeometry()
    geo2.setAttribute('position', new THREE.BufferAttribute(pos2, 3))
    const dust = new THREE.Points(geo2, new THREE.PointsMaterial({
      color: 0xaeb8dd,
      size: 0.016,
      transparent: true,
      opacity: 0.4,
      depthWrite: false
    }))
    scene.add(dust)

    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 32, 32),
      new THREE.MeshBasicMaterial({ color: ${hexToLiteral(accent)}, transparent: true, opacity: 0.12 })
    )
    scene.add(glow)

    const START = Number(window.__sceneStart?.[SCENE_ID] ?? 0)
    const DUR = ${durSec.toFixed(2)}
    function update(globalT) {
      if (globalT < START || globalT > START + DUR) return
      const t = Math.min(Math.max(globalT - START, 0), DUR)
      points.rotation.y = t * 0.10
      dust.rotation.y = -t * 0.055
      points.rotation.z = Math.sin(t * 0.2) * 0.06
      const s = 1 + Math.sin(t * 0.9) * 0.04
      glow.scale.setScalar(s)
      camera.position.z = 6 - Math.min(t * 0.05, 0.6)
      renderer.render(scene, camera)
    }
    window.addEventListener('hf-seek', (e) => update(e.detail.time))
    update(START)
  })()
  </script>`
}

function hexToLiteral(hex: string): string {
  return `0x${hex.replace('#', '').toUpperCase()}`
}
