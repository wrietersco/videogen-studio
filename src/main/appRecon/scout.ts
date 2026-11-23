import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'puppeteer-core'
import type { AppControl, AppField, AppMap, AppPage } from '@shared/appRecon'
import { classifyField, isSensitive, type RedactionOptions } from './sensitivity'
import { GENERIC_SENSITIVE_SELECTORS } from './sensitivity'

/**
 * Scout — reads a page the way a person would describe it: what it is called,
 * which boxes there are, what they are for, which controls exist, what it says.
 * It only looks; it never types or clicks (that is the playbook's job, behind
 * the policy gate).
 */

interface RawField { selector: string; label: string; inputType: string; name: string; id: string; placeholder: string; autocomplete: string; rect: { x: number; y: number; w: number; h: number } }
interface RawPage {
  title: string
  headings: string[]
  fields: RawField[]
  controls: AppControl[]
  notices: string[]
  text: string
  sections: NonNullable<AppPage['sections']>
}

/** the DOM-reading lookups both extraction passes share (no caps here) */
const DOM_HELPERS = String.raw`const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const path = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const name = el.getAttribute('name');
    if (name && document.querySelectorAll(el.tagName.toLowerCase() + '[name="' + name + '"]').length === 1) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const same = [...n.parentElement.children].filter((c) => c.tagName === n.tagName);
      parts.unshift(n.tagName.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : ''));
    }
    return parts.join(' > ');
  };
  const text = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const labelOf = (el) => {
    if (el.labels && el.labels[0]) return text(el.labels[0]);
    const aria = el.getAttribute('aria-label'); if (aria) return aria;
    const by = el.getAttribute('aria-labelledby'); if (by && document.getElementById(by)) return text(document.getElementById(by));
    return el.getAttribute('placeholder') || el.getAttribute('name') || '';
  };
  const around = (el) => { const box = el.closest('section,article,li,[class*=card],[class*=step]') || el.parentElement; return ((box && box.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 240); };
  const top = (el) => el.getBoundingClientRect().y + window.scrollY;`

/** the first screen's read: shallow caps, the way the map has always been built */
const EXTRACT = String.raw`(() => {
  ${DOM_HELPERS}
  const fields = [...document.querySelectorAll('input,select,textarea')]
    .filter((el) => shown(el) && !['hidden', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio'].includes((el.type || '').toLowerCase()))
    .map((el) => ({ selector: path(el), label: labelOf(el), inputType: el.type || el.tagName.toLowerCase(), name: el.getAttribute('name') || '', id: el.id || '', placeholder: el.getAttribute('placeholder') || '', autocomplete: el.getAttribute('autocomplete') || '', rect: rect(el) }));
  const controls = [...document.querySelectorAll('button,input[type=submit],input[type=button],a[href],[role=button]')]
    .filter(shown).slice(0, 60)
    .map((el) => ({ selector: path(el), label: text(el), kind: el.tagName === 'A' ? 'link' : 'button', href: el.tagName === 'A' ? el.href : undefined, rect: rect(el) }));
  const notices = [...document.querySelectorAll('[role=alert],[role=status],.flash,.alert,.error,.notification,.message,#flash')]
    .filter(shown).map(text).filter(Boolean).slice(0, 4);
  const main = document.querySelector('main,[role=main]') || document.body;
  const said = ((main && main.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 1400);
  const drawn = [...new Set([...document.querySelectorAll('svg text')].filter(shown).map((t) => (t.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length > 1 && t.length < 60))].slice(0, 60);
  const seen = new Set();
  const mk = (el, kind, label, extra) => { const l = (label || '').replace(/\s+/g, ' ').trim().slice(0, 80); if (!l || seen.has(kind + l.toLowerCase())) return null; seen.add(kind + l.toLowerCase()); return Object.assign({ label: l, selector: path(el), kind, y: Math.round(top(el)), text: around(el), expandable: el.tagName === 'SUMMARY' || el.getAttribute('aria-expanded') === 'false' || undefined }, extra || {}); };
  const sections = [];
  for (const h of document.querySelectorAll('h1,h2,h3,[role=region][aria-label],section[aria-label]')) { if (!shown(h)) continue; const m = mk(h, 'section', h.getAttribute('aria-label') && !/^H/.test(h.tagName) ? h.getAttribute('aria-label') : text(h)); if (m) sections.push(m); }
  for (const t of document.querySelectorAll('[role=tab]')) { if (!shown(t)) continue; const m = mk(t, 'tab', text(t)); if (m) sections.push(m); }
  for (const c of document.querySelectorAll('[class*=card],article')) { if (!shown(c)) continue; const h = c.querySelector('h1,h2,h3,h4,h5,strong'); const m = h ? mk(c, 'card', text(h)) : null; if (m) sections.push(m); }
  const stageGroups = [...document.querySelectorAll('ol, [class*=stepper], [class*=steps], [class*=timeline], [class*=stages], [class*=progress], [role=list]')];
  for (const g of stageGroups) {
    const items = [...g.children].filter(shown);
    if (items.length < 2) continue;
    const made = items.map((li) => { const h = li.querySelector('h1,h2,h3,h4,h5,strong,[class*=title],[class*=label]'); return mk(li, 'stage', text(h || li).split(/ - |: /)[0] || text(li)); }).filter(Boolean);
    if (made.length >= 2) { sections.push(...made); break; }
  }
  for (const h of document.querySelectorAll('h2,h3')) { if (!shown(h)) continue; if (/^(step|stage|phase)\s*\d+|^\d+[.):]/i.test(text(h))) { const m = mk(h, 'stage', text(h)); if (m) sections.push(m); } }
  return {
    sections: sections.slice(0, 40),
    text: said + (drawn.length ? ' | Labels drawn on the page: ' + drawn.join(', ') : ''),
    title: document.title,
    headings: [...document.querySelectorAll('h1,h2,h3')].filter(shown).map(text).filter(Boolean).slice(0, 8),
    fields, controls, notices
  };
})()`

/**
 * The deep read for a long page: same lookups, raised caps, plus the page's
 * named landmarks — regions with an id that hold a heading, and the navigation
 * links — so a page that runs past many screens is still understood whole.
 */
const DEEP_EXTRACT = String.raw`(() => {
  ${DOM_HELPERS}
  const seen = new Set();
  const mk = (el, kind, label, extra) => { const l = (label || '').replace(/\s+/g, ' ').trim().slice(0, 80); if (!l || seen.has(kind + l.toLowerCase())) return null; seen.add(kind + l.toLowerCase()); return Object.assign({ label: l, selector: path(el), kind, y: Math.round(top(el)), text: around(el), expandable: el.tagName === 'SUMMARY' || el.getAttribute('aria-expanded') === 'false' || undefined }, extra || {}); };
  const fields = [...document.querySelectorAll('input,select,textarea')]
    .filter((el) => shown(el) && !['hidden', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio'].includes((el.type || '').toLowerCase()))
    .map((el) => ({ selector: path(el), label: labelOf(el), inputType: el.type || el.tagName.toLowerCase(), name: el.getAttribute('name') || '', id: el.id || '', placeholder: el.getAttribute('placeholder') || '', autocomplete: el.getAttribute('autocomplete') || '', rect: rect(el) }));
  // the navigation's own links come first, so a page with more controls than the cap never loses them
  const controls = [];
  const seenCtl = new Set();
  const addCtl = (els) => { for (const el of els) { const sel = path(el); if (sel && !seenCtl.has(sel) && seenCtl.size < 120) { seenCtl.add(sel); controls.push({ selector: sel, label: text(el), kind: el.tagName === 'A' ? 'link' : 'button', href: el.tagName === 'A' ? el.href : undefined, rect: rect(el) }); } } };
  addCtl([...document.querySelectorAll('nav a[href],[role=navigation] a[href]')].filter(shown));
  addCtl([...document.querySelectorAll('button,input[type=submit],input[type=button],a[href],[role=button]')].filter(shown));
  const notices = [...document.querySelectorAll('[role=alert],[role=status],.flash,.alert,.error,.notification,.message,#flash')]
    .filter(shown).map(text).filter(Boolean).slice(0, 4);
  const main = document.querySelector('main,[role=main]') || document.body;
  const said = ((main && main.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  const drawn = [...new Set([...document.querySelectorAll('svg text')].filter(shown).map((t) => (t.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length > 1 && t.length < 60))].slice(0, 80);
  const sections = [];
  // a region with an id that holds a heading is the stable way back to it, so the landmarks are named first
  for (const el of document.querySelectorAll('[id]')) {
    if (!shown(el)) continue;
    const h = el.querySelector('h1,h2,h3,h4,h5');
    if (!h) continue;
    const m = mk(el, 'section', text(h));
    if (m) sections.push(m);
  }
  for (const h of document.querySelectorAll('h1,h2,h3,[role=region][aria-label],section[aria-label]')) { if (!shown(h)) continue; const m = mk(h, 'section', h.getAttribute('aria-label') && !/^H/.test(h.tagName) ? h.getAttribute('aria-label') : text(h)); if (m) sections.push(m); }
  for (const t of document.querySelectorAll('[role=tab]')) { if (!shown(t)) continue; const m = mk(t, 'tab', text(t)); if (m) sections.push(m); }
  for (const c of document.querySelectorAll('[class*=card],article')) { if (!shown(c)) continue; const h = c.querySelector('h1,h2,h3,h4,h5,strong'); const m = h ? mk(c, 'card', text(h)) : null; if (m) sections.push(m); }
  const stageGroups = [...document.querySelectorAll('ol, [class*=stepper], [class*=steps], [class*=timeline], [class*=stages], [class*=progress], [role=list]')];
  for (const g of stageGroups) {
    const items = [...g.children].filter(shown);
    if (items.length < 2) continue;
    const made = items.map((li) => { const h = li.querySelector('h1,h2,h3,h4,h5,strong,[class*=title],[class*=label]'); return mk(li, 'stage', text(h || li).split(/ - |: /)[0] || text(li)); }).filter(Boolean);
    if (made.length >= 2) { sections.push(...made); break; }
  }
  for (const h of document.querySelectorAll('h2,h3')) { if (!shown(h)) continue; if (/^(step|stage|phase)\s*\d+|^\d+[.):]/i.test(text(h))) { const m = mk(h, 'stage', text(h)); if (m) sections.push(m); } }
  return {
    sections: sections.slice(0, 80),
    text: said + (drawn.length ? ' | Labels drawn on the page: ' + drawn.join(', ') : ''),
    title: document.title,
    headings: [...document.querySelectorAll('h1,h2,h3')].filter(shown).map(text).filter(Boolean).slice(0, 24),
    fields, controls, notices
  };
})()`

/** sensitive selectors for one page (also used to blur the scout's own screenshots) */
export function selectorsFor(fields: AppField[]): string[] {
  return fields.filter((f) => f.sensitive).map((f) => f.selector)
}

const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** scrolls smoothly to a stop and waits for the page to actually be there (the recorder's way of looking around) */
async function smoothTo(page: Page, y: number): Promise<void> {
  await page.evaluate((stop) => scrollTo({ top: stop, behavior: 'smooth' }), y).catch(() => undefined)
  await nap(400)
  const until = Date.now() + 400
  while (Date.now() < until) {
    if (await page.evaluate((stop) => Math.abs(window.scrollY - stop) < 2, y).catch(() => true)) return
    await nap(60)
  }
}

/** the words after each line's kind prefix ("Tab: ") are the name itself — all the planner should match on */
export const POSSIBILITY_PREFIX = /^[A-Za-z]+: /

/**
 * What a person could be referring to on a page: its tabs, sections, stages,
 * cards, headings, chart labels and messages, as short human lines. Pure, so
 * the planner and the tests can use it without a browser.
 */
export function possibilitiesOf(p: Pick<AppPage, 'headings' | 'sections' | 'text' | 'notices'>): string[] {
  const kindOf: Record<string, string> = { section: 'Section', stage: 'Stage', tab: 'Tab', card: 'Card' }
  const out: string[] = []
  for (const s of p.sections ?? []) { if (s.label.trim()) out.push(`${kindOf[s.kind] ?? 'Section'}: "${s.label.trim()}"`) }
  for (const h of p.headings ?? []) { if (h.trim()) out.push(`Heading: "${h.trim()}"`) }
  const drawn = /Labels drawn on the page: (.*)$/s.exec(p.text ?? '')
  if (drawn?.[1].trim()) out.push(`Charts label: ${drawn[1].trim()}`)
  for (const n of p.notices ?? []) { if (n.trim()) out.push(`Message: "${n.trim()}"`) }
  const seen = new Set<string>()
  const lines: string[] = []
  for (const raw of out) {
    const line = raw.trim()
    if (!line || line.length > 90) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(line)
    if (lines.length >= 12) break
  }
  return lines
}

export async function scoutPage(page: Page, outDir: string, name: string, opts: RedactionOptions = {}): Promise<AppPage> {
  // measured first: how far the page runs past one screen decides how it is scouted
  const m = await page.evaluate(() => ({ doc: document.documentElement.scrollHeight, view: window.innerHeight })).catch(() => null)
  const raw = (await page.evaluate(EXTRACT)) as RawPage
  const classify = (fs: RawField[]): AppField[] =>
    fs.map((f) => {
      const kind = classifyField({ type: f.inputType, name: f.name, id: f.id, label: f.label, placeholder: f.placeholder, autocomplete: f.autocomplete })
      return { selector: f.selector, label: f.label, inputType: f.inputType, name: f.name, kind, sensitive: isSensitive(kind, opts), rect: f.rect }
    })
  const fields = classify(raw.fields)
  // the scout's own pictures are blurred with the same rules the recording uses;
  // the style stays mounted until every picture has been taken
  const css = [...GENERIC_SENSITIVE_SELECTORS, ...selectorsFor(fields)].map((s) => `${s}{filter:blur(9px)!important}`).join('\n')
  const style = await page.addStyleTag({ content: css })
  mkdirSync(outDir, { recursive: true })
  const file = `${name}.jpg`
  const shoot = (f: string) => page.screenshot({ path: join(outDir, f) as `${string}.jpg`, type: 'jpeg', quality: 85 })
  await shoot(file)
  const base: AppPage = { url: page.url(), title: raw.title, screenshot: file, headings: raw.headings, fields, controls: raw.controls, notices: raw.notices, text: raw.text, sections: raw.sections }
  if (!m || !(m.view > 0) || !(m.doc > 0)) {
    // the page could not be measured: keep exactly the one-screenshot look it always had
    await style.evaluate((el) => el.remove())
    return base
  }
  const scrolls = Math.max(0, Math.ceil((m.doc - m.view) / m.view))
  const shots: string[] = [file]
  if (scrolls > 0 && scrolls <= 5) {
    // a short page: picture it stop by stop down to the bottom, then go back up
    for (let i = 1; i <= scrolls; i++) {
      const next = `${name}-${i + 1}.jpg`
      await smoothTo(page, i === scrolls ? m.doc - m.view : i * m.view)
      if (await shoot(next).then(() => true).catch(() => false)) shots.push(next)
    }
    await smoothTo(page, 0)
  }
  let read = raw
  if (scrolls > 5) {
    // a long page: read it deeper instead of picturing every stop
    const deep = (await page.evaluate(DEEP_EXTRACT).catch(() => null)) as RawPage | null
    if (deep) read = deep
  }
  await style.evaluate((el) => el.remove())
  return {
    url: page.url(),
    title: read.title,
    screenshot: file,
    shots,
    scrolls,
    headings: read.headings,
    fields: classify(read.fields),
    controls: read.controls,
    notices: read.notices,
    text: read.text,
    sections: read.sections,
    possibilities: possibilitiesOf(read)
  }
}

const LOGIN_WORDS = /\b(log\s?-?in|sign\s?-?in|submit|continue|next|enter)\b/i

/** a sign-in form is a page with a password field, the box before it, and the control that sends it */
export function detectLogin(pages: AppPage[]): AppMap['login'] {
  for (const p of pages) {
    const pw = p.fields.find((f) => f.kind === 'password')
    if (!pw) continue
    const idx = p.fields.indexOf(pw)
    const user = [...p.fields.slice(0, idx)].reverse().find((f) => f.kind === 'username' || f.kind === 'email' || f.kind === 'text')
    const submit = p.controls.find((c) => c.kind === 'button' && LOGIN_WORDS.test(c.label)) ?? p.controls.find((c) => c.kind === 'button')
    return {
      detected: true,
      pageUrl: p.url,
      usernameSelector: user?.selector,
      passwordSelector: pw.selector,
      submitSelector: submit?.selector,
      submitLabel: submit?.label,
      otpLikely: p.fields.some((f) => f.kind === 'otp')
    }
  }
  return { detected: false, otpLikely: pages.some((p) => p.fields.some((f) => f.kind === 'otp')) }
}

export function buildAppMap(startUrl: string, pages: AppPage[]): AppMap {
  return {
    version: 1,
    startUrl,
    host: new URL(startUrl).hostname,
    scoutedAt: new Date().toISOString(),
    pages,
    login: detectLogin(pages),
    sensitiveSelectors: [...new Set(pages.flatMap((p) => selectorsFor(p.fields)))]
  }
}
