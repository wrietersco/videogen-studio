import { pageDetectorSource, type PrivateKind } from './detect'
import { GENERIC_SENSITIVE_SELECTORS } from './sensitivity'

/**
 * Redaction happens INSIDE the page, before the picture is ever taken, so a
 * blurred field is blurred in every frame — nothing is "fixed afterwards".
 *
 *  - selectors: sensitive fields (from the scout and from generic rules)
 *  - values:    secrets the run knows (typed credentials, names). Wherever one
 *               of them appears as visible text, it is wrapped and blurred too.
 *  - kinds:     private-looking text (tokens, card numbers, ssns; and with
 *               privacy mode emails, phone numbers, long numbers) is blurred
 *               wherever it appears, found by pattern.
 *  - privacy:   the person asked to hide personal data: the contents of tables,
 *               lists, fields, canvases and frames are blurred as whole blocks.
 *
 * Shadow DOM is covered too: every shadow root a page creates gets the same
 * style and is watched. Every step ends with a check (verifyScript) that looks
 * everywhere the blur does. A recording with even one unblurred sensitive
 * element is flagged and must not ship.
 */

export interface RedactionConfig {
  selectors: string[]
  values: string[]
  /** private-looking text to blur by pattern (default: tokens, card numbers, ssns) */
  kinds?: PrivateKind[]
  /** blur the contents of tables, lists, fields, canvases and frames as whole blocks */
  privacy?: boolean
}

/** what privacy mode blurs as whole blocks */
export const PRIVACY_BLOCKS = [
  'td',
  '[role="gridcell"]',
  '[role="cell"]',
  'dd',
  'input:not([type="password"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"])',
  'textarea',
  'select',
  'canvas',
  'iframe',
  'img[src*="avatar" i]',
  'img[alt*="avatar" i]',
  'img[class*="avatar" i]'
]

const DEFAULT_KINDS: PrivateKind[] = ['token', 'card', 'ssn']
const PRIVACY_KINDS: PrivateKind[] = ['token', 'card', 'ssn', 'email', 'phone', 'digits']

export function withGeneric(cfg: RedactionConfig): Required<RedactionConfig> {
  const privacy = cfg.privacy ?? false
  return {
    selectors: [...new Set([...GENERIC_SENSITIVE_SELECTORS, ...cfg.selectors, ...(privacy ? PRIVACY_BLOCKS : [])])],
    values: cfg.values.filter((v) => v.length >= 3),
    kinds: privacy ? PRIVACY_KINDS : (cfg.kinds ?? DEFAULT_KINDS),
    privacy
  }
}

const BLUR = 'blur(9px)'

/** runs before any page script, on every navigation, in every frame */
export function redactionInitScript(config: RedactionConfig): string {
  const c = withGeneric(config)
  const cfg = JSON.stringify({ selectors: c.selectors, values: c.values })
  return String.raw`(() => {
  if (window.__vgRoots) return;
  const cfg = ${cfg};
  const detect = ${pageDetectorSource(c.kinds)};
  const css = cfg.selectors.map((s) => s + '{filter:${BLUR} !important;}').join('\n') +
    '\n[data-vg-redact]{filter:${BLUR} !important;display:inline-block;}';
  const roots = [];
  Object.defineProperty(window, '__vgRoots', { value: roots });

  // the document's own style
  const mount = () => {
    if (!document.documentElement) return false;
    if (!document.getElementById('__vg_redact_css')) {
      const st = document.createElement('style');
      st.id = '__vg_redact_css';
      st.textContent = css;
      document.documentElement.appendChild(st);
    }
    return true;
  };
  if (!mount()) new MutationObserver((_, o) => { if (mount()) o.disconnect(); }).observe(document, { childList: true });

  // text to blur: known secret values, and anything that looks private
  const esc = (v) => v.replace(/[.*+?^$()|{}\[\]\\]/g, '\\$&');
  const valRe = cfg.values.length ? new RegExp('(' + cfg.values.map(esc).join('|') + ')', 'gi') : null;
  const rangesIn = (text) => {
    const out = [];
    if (valRe) for (const m of text.matchAll(valRe)) out.push([m.index, m.index + m[0].length]);
    for (const r of detect(text)) out.push([r.start, r.end]);
    out.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of out) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r.slice()); }
    return merged;
  };
  const scrubRoot = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentNode;
        if (!p || (p.nodeType === 1 && p.closest('script,style,textarea,[data-vg-redact]'))) return NodeFilter.FILTER_REJECT;
        return rangesIn(n.nodeValue).length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) hits.push(n);
    for (const n of hits) {
      const text = n.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const [a, b] of rangesIn(text)) {
        frag.appendChild(document.createTextNode(text.slice(last, a)));
        const span = document.createElement('span');
        span.setAttribute('data-vg-redact', '');
        span.textContent = text.slice(a, b);
        frag.appendChild(span);
        last = b;
      }
      frag.appendChild(document.createTextNode(text.slice(last)));
      n.parentNode.replaceChild(frag, n);
    }
  };
  let queued = false;
  const scrubAll = () => { if (document.body) scrubRoot(document.body); for (const r of roots) { styleRoot(r); scrubRoot(r); } };
  const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; scrubAll(); }); };
  const watch = (root) => new MutationObserver(later).observe(root, { childList: true, subtree: true, characterData: true });

  // shadow DOM: every root a page creates gets the same style and the same watching
  // an adopted stylesheet survives a page rewriting the root's contents (innerHTML = ...), which a style element would not
  let sheet = null;
  const styleRoot = (root) => {
    try {
      if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(css); }
      if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      return;
    } catch (e) {}
    if (!root.querySelector('style[data-vg]')) { const st = document.createElement('style'); st.setAttribute('data-vg', ''); st.textContent = css; root.appendChild(st); }
  };
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = attach.call(this, init);
    roots.push(root);
    styleRoot(root);
    watch(root);
    later();
    return root;
  };

  const start = () => { scrubAll(); watch(document.body); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();`
}

/** returns JSON {misses, detail}: sensitive things currently on screen that are NOT blurred (shadow DOM included) */
export function verifyScript(config: RedactionConfig): string {
  const c = withGeneric(config)
  const cfg = JSON.stringify({ selectors: c.selectors, values: c.values })
  return String.raw`(() => {
  const cfg = ${cfg};
  const detect = ${pageDetectorSource(c.kinds)};
  const roots = [document, ...(window.__vgRoots || [])];
  const blurred = (el) => {
    for (let n = el; n; n = n.parentNode || n.host) {
      if (n.nodeType === 1 && ((getComputedStyle(n).filter || '').includes('blur') || n.hasAttribute('data-vg-redact'))) return true;
    }
    return false;
  };
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const detail = [];
  for (const s of cfg.selectors) {
    for (const root of roots) {
      let els = [];
      try { els = [...root.querySelectorAll(s)]; } catch (e) { continue; }
      for (const el of els) if (shown(el) && !blurred(el)) detail.push(s);
    }
  }
  const vals = cfg.values.map((v) => v.toLowerCase());
  for (const root of roots) {
    const top = root === document ? (document.body || document.documentElement) : root;
    const walker = document.createTreeWalker(top, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest('script,style') || !shown(el)) continue;
      const low = n.nodeValue.toLowerCase();
      if ((vals.some((v) => low.includes(v)) || detect(n.nodeValue).length) && !blurred(el)) detail.push('text:' + n.nodeValue.slice(0, 12));
    }
    if (vals.length) for (const el of root.querySelectorAll('input,textarea')) {
      if (shown(el) && el.value && vals.some((v) => el.value.toLowerCase().includes(v)) && !blurred(el)) detail.push('value:' + (el.name || el.id || el.type));
    }
  }
  return JSON.stringify({ misses: detail.length, detail: detail.slice(0, 8) });
})()`
}

/** a visible mouse pointer and click ripple (headless Chrome draws neither) */
export function cursorInitScript(): string {
  return String.raw`(() => {
  const mount = () => {
    if (!document.documentElement) return false;
    if (document.getElementById('__vg_cursor')) return true;
    const st = document.createElement('style');
    st.textContent = '@keyframes __vg_rip{from{transform:translate(-50%,-50%) scale(.2);opacity:.75}to{transform:translate(-50%,-50%) scale(1.6);opacity:0}}';
    document.documentElement.appendChild(st);
    const c = document.createElement('div');
    c.id = '__vg_cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;pointer-events:none;transform:translate(-120px,-120px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))';
    c.innerHTML = '<svg width="30" height="30" viewBox="0 0 30 30"><path d="M3 2 L3 23 L8.6 18 L12.4 26.4 L16.2 24.7 L12.5 16.5 L20 16.5 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    document.addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; }, true);
    document.addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;width:64px;height:64px;border-radius:50%;background:rgba(80,140,255,.45);border:2px solid rgba(80,140,255,.9);left:' + e.clientX + 'px;top:' + e.clientY + 'px;animation:__vg_rip .55s ease-out forwards';
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 700);
    }, true);
    return true;
  };
  if (!mount()) new MutationObserver((_, o) => { if (mount()) o.disconnect(); }).observe(document, { childList: true });
})();`
}
