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
}

const EXTRACT = String.raw`(() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
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
  return {
    text: said + (drawn.length ? ' | Labels drawn on the page: ' + drawn.join(', ') : ''),
    title: document.title,
    headings: [...document.querySelectorAll('h1,h2,h3')].filter(shown).map(text).filter(Boolean).slice(0, 8),
    fields, controls, notices
  };
})()`

/** sensitive selectors for one page (also used to blur the scout's own screenshot) */
export function selectorsFor(fields: AppField[]): string[] {
  return fields.filter((f) => f.sensitive).map((f) => f.selector)
}

export async function scoutPage(page: Page, outDir: string, name: string, opts: RedactionOptions = {}): Promise<AppPage> {
  const raw = (await page.evaluate(EXTRACT)) as RawPage
  const fields: AppField[] = raw.fields.map((f) => {
    const kind = classifyField({ type: f.inputType, name: f.name, id: f.id, label: f.label, placeholder: f.placeholder, autocomplete: f.autocomplete })
    return { selector: f.selector, label: f.label, inputType: f.inputType, name: f.name, kind, sensitive: isSensitive(kind, opts), rect: f.rect }
  })
  // the scout's own picture is blurred with the same rules the recording uses
  const css = [...GENERIC_SENSITIVE_SELECTORS, ...selectorsFor(fields)].map((s) => `${s}{filter:blur(9px)!important}`).join('\n')
  const style = await page.addStyleTag({ content: css })
  mkdirSync(outDir, { recursive: true })
  const file = `${name}.jpg`
  await page.screenshot({ path: join(outDir, file) as `${string}.jpg`, type: 'jpeg', quality: 85 })
  await style.evaluate((el) => el.remove())
  return { url: page.url(), title: raw.title, screenshot: file, headings: raw.headings, fields, controls: raw.controls, notices: raw.notices, text: raw.text }
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
