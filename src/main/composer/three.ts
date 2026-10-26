import type { Scene } from '@shared/spec'

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

function materialSnippet(material: ShowcaseSpec['material'], accentHex: string, accent2Hex: string): string {
  switch (material) {
    case 'chrome':
      return `new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1.0, roughness: 0.12 })`
    case 'glass':
      // no `transmission`: it forces a second scene render pass — brutally slow
      // under software WebGL. Clearcoat + opacity reads as glass at a fraction of the cost.
      return `new THREE.MeshPhysicalMaterial({ color: 0xf8fbff, metalness: 0.1, roughness: 0.06, clearcoat: 1.0, clearcoatRoughness: 0.06, transparent: true, opacity: 0.55, envMapIntensity: 1.6 })`
    case 'matte':
      return `new THREE.MeshStandardMaterial({ color: ${accentHex}, metalness: 0.05, roughness: 0.85 })`
    case 'neon':
      return `new THREE.MeshStandardMaterial({ color: ${accentHex}, emissive: ${accentHex}, emissiveIntensity: 1.35, metalness: 0.3, roughness: 0.35 })`
    case 'iridescent':
      return `new THREE.MeshPhysicalMaterial({ color: ${accent2Hex}, metalness: 0.55, roughness: 0.18, iridescence: 1.0, iridescenceIOR: 1.6 })`
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
      camera.position.set(0, 0.15, 4.4)`
    case 'float':
      return `
      mesh.rotation.y = t * 0.45
      mesh.position.y = Math.sin(t * 1.05) * 0.22
      camera.position.set(0, 0.1, 4.4)`
    case 'dollyOrbit': {
      return `
      const a = -0.6 + t * 0.42
      const r = 4.9 - Math.sin(t * 0.35) * 0.55
      camera.position.set(Math.sin(a) * r, 0.55 + Math.sin(t * 0.22) * 0.35, Math.cos(a) * r)
      camera.lookAt(0, 0, 0)
      mesh.rotation.y = t * 0.28`
    }
    case 'explodeAssemble': {
      return `
      const k = 0.5 + 0.5 * Math.sin(t * 0.85 - Math.PI / 2)   // 0 → assembled, 1 → exploded
      mesh.rotation.y = t * 0.3
      mesh.position.y = 0
      shell.scale.setScalar(1 + k * 0.55)
      shell.material.opacity = 0.16 + k * 0.3
      shards.forEach((s, i) => {
        const dir = shardDirs[i]
        s.position.copy(dir).multiplyScalar(k * 1.5)
        s.rotation.x = t * (0.7 + i * 0.2)
        s.rotation.y = t * (0.5 + i * 0.3)
      })
      camera.position.set(0, 0.2, 5.0)`
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
  accent2: string
): string {
  const accentHex = hexToLiteral(accent)
  const accent2Hex = hexToLiteral(accent2)
  const needsShards = motion === 'explodeAssemble'
  const needsShell = motion === 'explodeAssemble' || objectStyle === 'sphereGrid'
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
    host.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 100)
    camera.position.set(0, 0.2, 4.6)

    // procedural environment (deterministic): painted equirect → PMREM
    const envCanvas = document.createElement('canvas')
    envCanvas.width = 512; envCanvas.height = 256
    const g = envCanvas.getContext('2d')
    const grad = g.createLinearGradient(0, 0, 0, 256)
    grad.addColorStop(0, '#3a3a55')
    grad.addColorStop(0.5, '#15151f')
    grad.addColorStop(1, '#05050a')
    g.fillStyle = grad; g.fillRect(0, 0, 512, 256)
    g.fillStyle = 'rgba(255,255,255,0.9)'
    g.fillRect(40, 40, 130, 26)
    g.fillRect(330, 90, 120, 20)
    g.fillStyle = '${accent}'
    g.fillRect(180, 30, 90, 22)
    const envTex = new THREE.CanvasTexture(envCanvas)
    envTex.mapping = THREE.EquirectangularReflectionMapping
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromEquirectangular(envTex).texture

    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(3, 5, 4)
    scene.add(key)
    const rim = new THREE.DirectionalLight(${accent2Hex}, 2.2)
    rim.position.set(-4, -2, -3)
    scene.add(rim)

    const geometry = ${GEOMETRY_SNIPPETS[objectStyle]}
    const mat = ${materialSnippet(material, accentHex, accent2Hex)}
    const mesh = new THREE.Mesh(geometry, mat)
    scene.add(mesh)
    ${needsShell ? `
    const shell = new THREE.Mesh(
      ${objectStyle === 'sphereGrid' ? 'new THREE.IcosahedronGeometry(1.46, 1)' : `${GEOMETRY_SNIPPETS[objectStyle]}.clone()`},
      new THREE.MeshBasicMaterial({ color: ${accent2Hex}, wireframe: true, transparent: true, opacity: 0.2 })
    )
    scene.add(shell)` : 'const shell = mesh'}
    ${needsShards ? `
    const rand = mulberry32(${seed} * 7919 + 13)
    const shardDirs = [0, 1, 2, 3, 4].map(() => {
      const v = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1)
      return v.normalize()
    })
    const shards = shardDirs.map(() => {
      const s = new THREE.Mesh(new THREE.TetrahedronGeometry(0.22), mat)
      scene.add(s)
      return s
    })` : 'const shards = []; const shardDirs = []'}

    const START = Number(window.__sceneStart?.[SCENE_ID] ?? 0)
    const DUR = ${durSec.toFixed(2)}
    function update(globalT) {
      const t = Math.min(Math.max(globalT - START, 0), DUR)
      ${motionSnippet(motion)}
      camera.lookAt(0, 0, 0)
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

    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 32, 32),
      new THREE.MeshBasicMaterial({ color: ${hexToLiteral(accent)}, transparent: true, opacity: 0.12 })
    )
    scene.add(glow)

    const START = Number(window.__sceneStart?.[SCENE_ID] ?? 0)
    const DUR = ${durSec.toFixed(2)}
    function update(globalT) {
      const t = Math.min(Math.max(globalT - START, 0), DUR)
      points.rotation.y = t * 0.10
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
