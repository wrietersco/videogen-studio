import { classifyField, isSensitive } from './sensitivity'

/**
 * Runs before any page script, on every page and frame the recording opens. It does three things the page-reading
 * code cannot do afterwards:
 *
 *  1. remembers which elements the page attached click / pointer / drag listeners to, so a plain <div> that does
 *     something when pressed is a candidate for a click (window.__vgListening);
 *  2. counts what changes in the page (window.__vgProbe.mut), so an action can be checked by "did the page react?";
 *  3. classifies every input AS IT APPEARS (the same rules the scout uses) and blurs the private ones, so a field the
 *     scout never saw (a late popup's e-mail box) is never filmed in the clear.
 */

/** what the scout's classifier decides, as plain text a page can run (it has no outside references) */
const classifySource = classifyField.toString()
const sensitiveSource = isSensitive.toString()

export function probeInitScript(): string {
  return String.raw`(() => {
  if (window.__vgProbe) return;
  const P = { mut: 0 };
  Object.defineProperty(window, '__vgProbe', { value: P });
  const listening = new WeakSet();
  Object.defineProperty(window, '__vgListening', { value: listening });
  const classify = (${classifySource});
  const sensitive = (${sensitiveSource});
  const roots = [];
  Object.defineProperty(window, '__vgProbeRoots', { value: roots });

  // 1. listeners
  const EV = /^(click|mousedown|mouseup|pointerdown|pointerup|touchstart|touchend|dragstart|dblclick)$/;
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    try { if (this && this.nodeType === 1 && EV.test(type)) listening.add(this); } catch (e) {}
    return add.call(this, type, fn, opts);
  };

  // 2. changes (the recorder's own cursor and click ripples do not count)
  const ours = (n) => { try { const el = n.nodeType === 1 ? n : n.parentElement; return !!el && (el.id === '__vg_cursor' || el.hasAttribute('data-vg-ui') || !!el.closest('#__vg_cursor,[data-vg-ui]')); } catch (e) { return false; } };
  const count = (recs) => { for (const r of recs) { if (ours(r.target)) continue; if (r.type === 'attributes' && (r.attributeName === 'data-vg-blur' || r.attributeName === 'data-vg-redact')) continue; if (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(ours)) continue; P.mut++; } };
  const watch = (root) => { try { new MutationObserver(count).observe(root, { subtree: true, childList: true, attributes: true, characterData: true }); } catch (e) {} };
  const mount = () => { if (!document.documentElement) return false; watch(document); return true; };
  if (!mount()) new MutationObserver((_, o) => { if (mount()) o.disconnect(); }).observe(document, { childList: true });

  // 3. private fields
  const labelOf = (el) => {
    try {
      const out = [];
      for (const l of el.labels || []) out.push(l.innerText || l.textContent || '');
      const by = el.getAttribute('aria-labelledby');
      if (by) for (const id of by.split(/\s+/)) { const e = (el.getRootNode().getElementById ? el.getRootNode() : document).getElementById(id); if (e) out.push(e.innerText || e.textContent || ''); }
      out.push(el.getAttribute('aria-label') || '');
      if (!out.join('').trim()) { const lab = el.closest('label'); if (lab) out.push(lab.innerText || lab.textContent || ''); }
      return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    } catch (e) { return ''; }
  };
  const FIELD = 'input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox]';
  const check = (el) => {
    try {
      if (el.nodeType !== 1) return;
      const type = (el.type || el.getAttribute('type') || (el.isContentEditable ? 'text' : '')).toLowerCase();
      if (/^(hidden|checkbox|radio|button|submit|reset|image|range|color|file)$/.test(type)) return;
      const kind = classify({ type, name: el.getAttribute('name') || '', id: el.id || '', label: labelOf(el), placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '', autocomplete: el.getAttribute('autocomplete') || '' });
      if (sensitive(kind, {}) && kind !== 'username') el.setAttribute('data-vg-blur', kind);
    } catch (e) {}
  };
  const scan = (root) => { try { if (root.matches && root.matches(FIELD)) check(root); for (const el of root.querySelectorAll(FIELD)) check(el); } catch (e) {} };
  const startScan = () => {
    scan(document);
    new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1) scan(n); }).observe(document, { subtree: true, childList: true });
    // a field whose hints change (a placeholder set late) is looked at again when it is used
    document.addEventListener('focusin', (e) => { const t = e.composedPath ? e.composedPath()[0] : e.target; if (t && t.matches && t.matches(FIELD)) check(t); }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startScan); else startScan();
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = attach.call(this, init);
    roots.push(root);
    watch(root);
    try { new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1) scan(n); }).observe(root, { subtree: true, childList: true }); } catch (e) {}
    setTimeout(() => scan(root), 0);
    return root;
  };
})();`
}
