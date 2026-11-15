import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A small business website for testing "market your business" without the
 * internet: a home page that names the services in its navigation, two
 * services pages with real content, and the pages a good read should skip
 * (a blog post and a contact form). The brand is easy to find: a theme
 * colour, a meta description and a logo drawn right into the header.
 */

export interface BizSite {
  /** http://localhost:<port> */
  url: string
  close(): Promise<void>
}

const STYLE = `<style>
  body{font:16px system-ui;margin:0;color:#222}
  header{display:flex;align-items:center;gap:12px;padding:14px 24px}
  header nav a{margin-left:14px;color:#1a5c1a}
  main{padding:24px;max-width:820px}
  footer{padding:20px 24px;color:#777}
</style>`

const page = (title: string, description: string, inner: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${description}"><meta name="theme-color" content="#1a5c1a">${STYLE}</head><body>${inner}</body></html>`

const HOME = page(
  'GreenLeaf Landscapes — gardens that take care of themselves',
  'Garden design and care for busy families in Lisbon. We design, build and look after low-maintenance gardens.',
  `<header><a href="/"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='40'%3E%3Crect width='120' height='40' fill='%231a5c1a'/%3E%3Ctext x='8' y='28' fill='white' font-size='18'%3EGreenLeaf%3C/text%3E%3C/svg%3E" alt="GreenLeaf Landscapes logo" class="site-logo"></a>
  <nav><a href="/">Home</a><a href="/services">Our services</a><a href="/garden-design">Garden design</a><a href="/garden-care">Garden care plans</a><a href="/blog/autumn-tulips">Blog</a><a href="/contact">Contact</a></nav></header>
  <main>
    <h1>Gardens that take care of themselves</h1>
    <p>GreenLeaf Landscapes designs, builds and maintains gardens for busy families across Lisbon. From a first sketch to year-round care, one team looks after the whole garden.</p>
    <h2>How we work</h2>
    <ul><li>We visit your garden and listen to what you want from it</li><li>You get a planting plan you can read at a glance</li><li>Our team builds it in days, not weeks</li></ul>
    <h2>Why families stay with us</h2>
    <p>Watering, pruning and seasonal colour are all covered by one monthly plan, so the garden is always ready for the weekend.</p>
  </main>
  <footer><a href="https://instagram.com/greenleaf">Follow us</a> — Lisbon, Portugal</footer>`
)

const SERVICES = page(
  'Our services — GreenLeaf Landscapes',
  'Garden design, build and care: the two services every GreenLeaf garden is built on.',
  `<header><a href="/"><span class="site-title">GreenLeaf Landscapes</span></a><nav><a href="/">Home</a><a href="/services">Our services</a><a href="/garden-design">Garden design</a><a href="/garden-care">Garden care plans</a><a href="/contact">Contact</a></nav></header>
  <main><h1>Our services</h1><p>Two services, one team: we design and build the garden, then keep it looking its best all year.</p>
  <h2>Garden design</h2><p>A full planting plan for your space, light and soil — see <a href="/garden-design">garden design</a>.</p>
  <h2>Garden care plans</h2><p>Monthly visits that cover watering, pruning and seasonal colour — see <a href="/garden-care">garden care plans</a>.</p></main>`
)

const DESIGN = page(
  'Garden design — GreenLeaf Landscapes',
  'A planting plan for your space, light and soil, drawn in three weeks.',
  `<header><a href="/"><span class="site-title">GreenLeaf Landscapes</span></a><nav><a href="/">Home</a><a href="/services">Our services</a><a href="/garden-design">Garden design</a><a href="/garden-care">Garden care plans</a></nav></header>
  <main><h1>Garden design</h1>
  <p>We measure your garden, watch where the sun falls and listen to how you want to live in it. Three weeks later you have a complete planting plan with drawings you can read at a glance.</p>
  <h2>What you get</h2>
  <ul><li>A planting plan matched to your soil and light</li><li>A shopping list of plants with sizes and numbers</li><li>One revision round included</li></ul>
  <h2>Good to know</h2><p>Every design is drawn by one of our two senior designers, never outsourced.</p></main>`
)

const CARE = page(
  'Garden care plans — GreenLeaf Landscapes',
  'Monthly visits that keep the garden healthy without you lifting a spade.',
  `<header><a href="/"><span class="site-title">GreenLeaf Landscapes</span></a><nav><a href="/">Home</a><a href="/services">Our services</a><a href="/garden-design">Garden design</a><a href="/garden-care">Garden care plans</a></nav></header>
  <main><h1>Garden care plans</h1>
  <p>A trained gardener visits every month: watering systems checked, hedges trimmed, beds fed, and seasonal colour swapped twice a year. You never think about the garden between visits.</p>
  <h2>What is covered</h2>
  <ul><li>Monthly visit by the same gardener</li><li>Watering and irrigation checks</li><li>Pruning, feeding and pest watch</li></ul>
  <p>Plans start at one small visit a month; most gardens do well with the middle plan.</p></main>`
)

const BLOG = page('Autumn tulips — the GreenLeaf blog', 'What to plant this autumn.', `<header><a href="/">GreenLeaf Landscapes</a></header><main><h1>Five bulbs for autumn</h1><p>Tulips go in when the soil cools down. Here are five that never disappoint.</p></main>`)
const CONTACT = page('Contact — GreenLeaf Landscapes', 'Write to us.', `<header><a href="/">GreenLeaf Landscapes</a></header><main><h1>Contact</h1><form><input name="email" type="email"><button>Send</button></form><p>Or call us on weekdays.</p></main>`)

export async function startBizSite(): Promise<BizSite> {
  const routes: Record<string, string> = {
    '/': HOME,
    '/services': SERVICES,
    '/garden-design': DESIGN,
    '/garden-care': CARE,
    '/blog/autumn-tulips': BLOG,
    '/contact': CONTACT
  }
  const server: Server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    const path = (_req.url ?? '/').split('?')[0].replace(/\/$/, '') || '/'
    const body = routes[path]
    if (body) res.writeHead(200, { 'content-type': 'text/html' }).end(body)
    else res.writeHead(404).end('not found')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}
