import { GENERIC_SENSITIVE_SELECTORS } from './sensitivity'

/**
 * Redaction happens INSIDE the page, before the picture is ever taken, so a
 * blurred field is blurred in every frame — nothing is "fixed afterwards".
 *
 *  - selectors: sensitive fields (from the scout and from generic rules)
 *  - values:    secrets the run knows (typed credentials, names). Wherever one
 *               of them appears as visible text, it is wrapped and blurred too.
 *
 * Every step ends with a check (verifyScript). A recording with even one
 * unblurred sensitive element is flagged and must not ship.
 */

export interface RedactionConfig {
  selectors: string[]
  values: string[]
}

export function withGeneric(cfg: RedactionConfig): RedactionConfig {
  return { selectors: [...new Set([...GENERIC_SENSITIVE_SELECTORS, ...cfg.selectors])], values: cfg.values.filter((v) => v.length >= 3) }
}

const BLUR = 'blur(9px)'

/** runs before any page script, on every navigation */
export function redactionInitScript(config: RedactionConfig): string {
  const cfg = JSON.stringify(withGeneric(config))
  return String.raw`(() => {
  const cfg = ${cfg};
  const css = cfg.selectors.map((s) => s + '{filter:${BLUR} !important;}').join('\n') +
    '\n[data-vg-redact]{filter:${BLUR} !important;display:inline-block;}';
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
  const vals = cfg.values.map((v) => v.toLowerCase());
  if (!vals.length) return;
  const esc = (v) => v.replace(/[.*+?^$()|{}\[\]\\]/g, '\\$&');
  const re = new RegExp('(' + cfg.values.map(esc).join('|') + ')', 'gi');
  const scrub = () => {
    if (!document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n.parentElement && !n.parentElement.closest('script,style,textarea,[data-vg-redact]') && vals.some((v) => n.nodeValue.toLowerCase().includes(v))
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) hits.push(n);
    for (const n of hits) {
      const frag = document.createDocumentFragment();
      let last = 0;
      const text = n.nodeValue;
      text.replace(re, (m, g, idx) => {
        frag.appendChild(document.createTextNode(text.slice(last, idx)));
        const span = document.createElement('span');
        span.setAttribute('data-vg-redact', '');
        span.textContent = m;
        frag.appendChild(span);
        last = idx + m.length;
        return m;
      });
      frag.appendChild(document.createTextNode(text.slice(last)));
      n.parentNode.replaceChild(frag, n);
    }
  };
  let queued = false;
  const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; scrub(); }); };
  const start = () => { scrub(); new MutationObserver(later).observe(document.body, { childList: true, subtree: true, characterData: true }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();`
}

/** returns JSON {misses, detail}: sensitive things currently on screen that are NOT blurred */
export function verifyScript(config: RedactionConfig): string {
  const cfg = JSON.stringify(withGeneric(config))
  return String.raw`(() => {
  const cfg = ${cfg};
  const blurred = (el) => (getComputedStyle(el).filter || '').includes('blur') || !!el.closest('[data-vg-redact]');
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const detail = [];
  for (const s of cfg.selectors) {
    let els = [];
    try { els = [...document.querySelectorAll(s)]; } catch (e) { continue; }
    for (const el of els) if (shown(el) && !blurred(el)) detail.push(s);
  }
  const vals = cfg.values.map((v) => v.toLowerCase());
  if (vals.length) {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest('script,style') || !shown(el)) continue;
      const low = n.nodeValue.toLowerCase();
      if (vals.some((v) => low.includes(v)) && !blurred(el)) detail.push('text:' + n.nodeValue.slice(0, 12));
    }
    for (const el of document.querySelectorAll('input,textarea')) {
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
