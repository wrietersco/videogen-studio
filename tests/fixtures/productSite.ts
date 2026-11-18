import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import sharp from 'sharp'

/**
 * A small bakery website with real picture files, for testing how the
 * product pictures are taken: product photos with alt text under their
 * headings, a share picture (og:image), a gallery photo, and the pictures
 * a good read must leave out (the logo, a tiny icon, a sprite strip, a
 * flat placeholder, and the same photo again at another size).
 */

export interface ProductSite {
  url: string
  close(): Promise<void>
}

/** a picture with shapes in it (so it is not flat), different for each seed */
async function photo(seed: number, w: number, h: number): Promise<Buffer> {
  // an 8 by 6 patchwork whose brightness comes from the seed, so no two pictures look alike
  const cells: string[] = []
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 8; x++) {
      const v = Math.abs(Math.sin(seed * 12.9898 + x * 78.233 + y * 37.719) * 43758.5453) % 1
      cells.push(`<rect x="${Math.round((x * w) / 8)}" y="${Math.round((y * h) / 6)}" width="${Math.ceil(w / 8)}" height="${Math.ceil(h / 6)}" fill="hsl(${Math.round((seed * 67 + v * 90) % 360)},55%,${Math.round(15 + v * 70)}%)"/>`)
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${cells.join('')}</svg>`
  return sharp(Buffer.from(svg)).jpeg().toBuffer()
}

const STYLE = '<style>body{font:16px system-ui;margin:0}header{display:flex;gap:12px;padding:12px}main{padding:20px}img{display:block;max-width:420px}</style>'
const page = (title: string, inner: string, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="Fresh cookies and brownies baked every morning in Lahore.">${head}${STYLE}</head><body>${inner}</body></html>`
const HEADER = `<header><a href="/"><img src="/img/logo.png" alt="Crumb & Co logo" class="site-logo" style="width:160px"></a><nav><a href="/services/treat-boxes">Cookie boxes</a> <a href="/services/brownie-trays">Brownie trays</a><img src="/img/cart-icon.png" alt="cart" style="width:24px"></nav></header>`

export async function startProductSite(): Promise<ProductSite> {
  const box = await photo(1, 900, 700)
  const files: Record<string, { type: string; body: Buffer }> = {
    '/img/box.jpg': { type: 'image/jpeg', body: box },
    '/img/box-small.jpg': { type: 'image/jpeg', body: await sharp(box).resize(600).jpeg().toBuffer() },
    '/img/tray.jpg': { type: 'image/jpeg', body: await photo(2, 1000, 750) },
    '/img/party.jpg': { type: 'image/jpeg', body: await photo(3, 1200, 800) },
    '/img/og.jpg': { type: 'image/jpeg', body: await photo(4, 1200, 630) },
    '/img/flat.jpg': { type: 'image/jpeg', body: await sharp({ create: { width: 800, height: 600, channels: 3, background: '#dddddd' } }).jpeg().toBuffer() },
    '/img/logo.png': { type: 'image/png', body: await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100"><circle cx="50" cy="50" r="38" fill="#7a1f3d"/><circle cx="40" cy="42" r="8" fill="#f4d9a8"/><circle cx="62" cy="58" r="8" fill="#f4d9a8"/><rect x="104" y="30" width="190" height="14" rx="7" fill="#7a1f3d"/><rect x="104" y="56" width="120" height="14" rx="7" fill="#c58a4a"/></svg>')).png().toBuffer() },
    '/img/cart-icon.png': { type: 'image/png', body: await sharp({ create: { width: 32, height: 32, channels: 4, background: '#333' } }).png().toBuffer() },
    '/img/sprite.png': { type: 'image/png', body: await sharp({ create: { width: 2000, height: 40, channels: 3, background: '#a33' } }).png().toBuffer() }
  }
  const pages: Record<string, string> = {
    '/': page(
      'Crumb & Co — cookies worth sharing',
      `${HEADER}<main><h1>Cookies worth sharing</h1><p>Small-batch cookies and brownies, baked every morning and boxed for offices, birthdays and gifts.</p>
      <section class="product-grid"><div class="product-card"><h2>Cookie boxes</h2><img src="/img/box.jpg" alt="Cookie box of twelve" width="420"></div></section>
      <figure><img src="/img/party.jpg" alt="" width="420"><figcaption>Office party platter</figcaption></figure>
      <img src="/img/sprite.png" alt="" style="width:400px;height:8px">
      <img src="/img/flat.jpg" alt="placeholder picture" width="300"></main>`,
      '<meta property="og:image" content="/img/og.jpg">'
    ),
    '/services/treat-boxes': page('Cookie boxes — Crumb & Co', `${HEADER}<main><h1>Cookie boxes</h1><p>Boxes of six, twelve or twenty-four cookies, packed the same morning they are baked.</p><ul><li>Packed the morning they are baked</li><li>Free delivery across Lahore</li></ul><img src="/img/box.jpg?w=300" alt="Cookie box" width="300"><img src="/img/box-small.jpg" alt="Our cookie box" width="300"></main>`),
    '/services/brownie-trays': page('Brownie trays — Crumb & Co', `${HEADER}<main><h1>Brownie trays</h1><p>Fudge brownie trays cut into sixteen squares, made for sharing at the office.</p><ul><li>Sixteen fudge squares in every tray</li><li>Ordered by noon, delivered by four</li></ul><div class="gallery"><img src="/img/tray.jpg" alt="Fudge brownie tray" width="420"></div></main>`)
  }
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0].replace(/\/$/, '') || '/'
    const f = files[path]
    if (f) return void res.writeHead(200, { 'content-type': f.type }).end(f.body)
    const body = pages[path]
    if (body) res.writeHead(200, { 'content-type': 'text/html' }).end(body)
    else res.writeHead(404).end('not found')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}
