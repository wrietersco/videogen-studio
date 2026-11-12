/**
 * The art kit handed to model-authored canvas scenes.
 *
 * A code model asked to draw a whole scene from bare canvas calls spends its
 * effort on projection maths and gets flat, misaligned shapes. The kit carries
 * the craft instead — a true isometric projection, lit solids, liquids, pipes,
 * particles, easing, labels — so the model composes a scene out of parts that
 * already look right, and its code stays short enough to get correct.
 *
 * CANVAS_KIT_SOURCE is plain JavaScript evaluated inside the sandboxed scene
 * frame (it defines makeKit(ctx,w,h)); it must stay deterministic and free of
 * backticks. CANVAS_KIT_GUIDE is the reference the author model is given.
 */

export const CANVAS_KIT_SOURCE = String.raw`
function makeKit(ctx, w, h) {
  var K = {};
  var U = Math.min(w, h) / 1080;
  K.u = U;

  // ---------- numbers and time ----------
  K.clamp = function (x, a, b) { a = a === undefined ? 0 : a; b = b === undefined ? 1 : b; return Math.min(b, Math.max(a, x)); };
  K.lerp = function (a, b, u) { return a + (b - a) * u; };
  K.ease = {
    linear: function (x) { return x; },
    in: function (x) { return x * x * x; },
    out: function (x) { return 1 - Math.pow(1 - x, 3); },
    inOut: function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; },
    back: function (x) { var c = 1.70158; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); },
    bounce: function (x) { var n = 7.5625, d = 2.75; if (x < 1 / d) return n * x * x; if (x < 2 / d) { x -= 1.5 / d; return n * x * x + 0.75; } if (x < 2.5 / d) { x -= 2.25 / d; return n * x * x + 0.9375; } x -= 2.625 / d; return n * x * x + 0.984375; }
  };
  // eased 0..1 progress of time t between start and end seconds
  K.prog = function (t, start, end, ease) {
    var x = K.clamp((t - start) / Math.max(0.0001, end - start));
    return (K.ease[ease || 'inOut'] || K.ease.inOut)(x);
  };
  K.loop = function (t, period, phase) { var x = (t / period + (phase || 0)) % 1; return x < 0 ? x + 1 : x; };
  K.wave = function (t, period, phase) { return Math.sin((t / period + (phase || 0)) * Math.PI * 2); };
  K.rand = function (seed) { var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123; return x - Math.floor(x); };

  // ---------- colour ----------
  var probe = document.createElement('canvas').getContext('2d');
  function rgb(c) {
    // a gradient, pattern or missing value is not a colour string: use a neutral grey instead of throwing
    if (typeof c !== 'string') return [128, 128, 128, 1];
    probe.fillStyle = '#000'; probe.fillStyle = c; var s = probe.fillStyle;
    if (typeof s !== 'string') return [128, 128, 128, 1];
    if (s.charAt(0) === '#') return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 1];
    var m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return [0, 0, 0, 1];
    var p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  function css(v) { return 'rgba(' + Math.round(v[0]) + ',' + Math.round(v[1]) + ',' + Math.round(v[2]) + ',' + (Math.round(v[3] * 1000) / 1000) + ')'; }
  // amount -1 (black) .. 0 (unchanged) .. 1 (white)
  K.shade = function (c, amount) { var v = rgb(c), to = amount < 0 ? 0 : 255, a = Math.abs(amount); return css([v[0] + (to - v[0]) * a, v[1] + (to - v[1]) * a, v[2] + (to - v[2]) * a, v[3]]); };
  K.alpha = function (c, a) { var v = rgb(c); return css([v[0], v[1], v[2], v[3] * a]); };
  K.mix = function (a, b, u) { var x = rgb(a), y = rgb(b); return css([K.lerp(x[0], y[0], u), K.lerp(x[1], y[1], u), K.lerp(x[2], y[2], u), K.lerp(x[3], y[3], u)]); };
  // ready-made material colours that read well against a dark backdrop
  K.colors = { land: '#2c6b5c', grass: '#4bb06a', sand: '#d9c28f', rock: '#5f7890', snow: '#f3f8ff', concrete: '#a9b4bf', steel: '#c7d0d9', dark: '#3b4a5c', water: '#2f9bff', glass: '#bfe6ff', wood: '#9a6b45', roof: '#d9634a', wall: '#e8e2d6', warm: '#ffd774', hot: '#ff7a45', leaf: '#3f9d5b', cloud: '#dfe9f3' };
  // the world is lit: a solid painted in a near-black colour vanishes into the
  // backdrop, so very dark object colours are lifted to a readable tone of the same hue
  function lit(c) {
    if (typeof c !== 'string') return '#8a96a3';
    var v = rgb(c), lum = (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255;
    if (lum >= 0.2) return c;
    var k = (0.2 - lum) / (1 - lum) + 0.06;
    return css([v[0] + (255 - v[0]) * k, v[1] + (255 - v[1]) * k, v[2] + (255 - v[2]) * k, v[3]]);
  }

  // ---------- flat helpers ----------
  function poly(points, fill, stroke, lineWidth) {
    ctx.beginPath();
    for (var i = 0; i < points.length; i++) { if (i === 0) ctx.moveTo(points[i].x, points[i].y); else ctx.lineTo(points[i].x, points[i].y); }
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth || 1.5 * U; ctx.lineJoin = 'round'; ctx.stroke(); }
  }
  K.poly = poly;
  K.roundRect = function (x, y, rw, rh, r, fill, stroke) {
    r = Math.min(r, rw / 2, rh / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + rw, y, x + rw, y + rh, r); ctx.arcTo(x + rw, y + rh, x, y + rh, r); ctx.arcTo(x, y + rh, x, y, r); ctx.arcTo(x, y, x + rw, y, r); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2 * U; ctx.stroke(); }
  };
  // full-frame backdrop: vertical gradient, soft light pool, faint floor grid, vignette
  K.bg = function (top, bottom, o) {
    o = o || {};
    var g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, top); g.addColorStop(1, bottom);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    if (o.glow !== false) {
      var gx = (o.glowX === undefined ? 0.5 : o.glowX) * w, gy = (o.glowY === undefined ? 0.55 : o.glowY) * h;
      var rg = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(w, h) * 0.6);
      rg.addColorStop(0, K.alpha(o.glowColor || '#ffffff', o.glowAlpha === undefined ? 0.1 : o.glowAlpha)); rg.addColorStop(1, K.alpha(o.glowColor || '#ffffff', 0));
      ctx.fillStyle = rg; ctx.fillRect(0, 0, w, h);
    }
    if (o.vignette !== false) {
      var vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.78);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,' + (o.vignetteAlpha === undefined ? 0.34 : o.vignetteAlpha) + ')');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
    }
  };
  K.glow = function (x, y, r, color, alpha) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, K.alpha(color, alpha === undefined ? 0.5 : alpha)); g.addColorStop(1, K.alpha(color, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  };
  var FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
  K.text = function (str, x, y, o) {
    o = o || {};
    ctx.save();
    ctx.globalAlpha *= o.alpha === undefined ? 1 : o.alpha;
    ctx.font = (o.weight || 700) + ' ' + Math.round((o.size || 44) * U) + 'px ' + FONT;
    ctx.textAlign = o.align || 'left'; ctx.textBaseline = o.baseline || 'alphabetic';
    if (o.shadow !== false) { ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 14 * U; ctx.shadowOffsetY = 3 * U; }
    ctx.fillStyle = o.color || '#ffffff'; ctx.fillText(String(str), x, y);
    ctx.restore();
  };
  // headline block that slides in; appear = 0..1
  K.title = function (headline, subline, o) {
    o = o || {};
    var a = o.appear === undefined ? 1 : K.clamp(o.appear), x = (o.x === undefined ? 0.06 : o.x) * w, y = (o.y === undefined ? 0.13 : o.y) * h;
    if (a <= 0) return;
    ctx.save(); ctx.globalAlpha *= a; ctx.translate(0, (1 - a) * 26 * U);
    ctx.fillStyle = o.accent || '#ffffff'; ctx.fillRect(x, y - 54 * U, 64 * U * a, 6 * U);
    K.text(headline, x, y, { size: o.size || 58, weight: 800, color: o.color || '#ffffff' });
    if (subline) K.text(subline, x, y + 46 * U, { size: (o.size || 58) * 0.48, weight: 500, color: K.alpha(o.color || '#ffffff', 0.78) });
    ctx.restore();
  };
  // pill label, optionally with a leader line to the thing it names; appear = 0..1
  K.label = function (str, x, y, o) {
    o = o || {};
    var a = o.appear === undefined ? 1 : K.clamp(o.appear); if (a <= 0) return;
    var size = (o.size || 26) * U;
    ctx.save(); ctx.globalAlpha *= a;
    ctx.font = '700 ' + Math.round(size) + 'px ' + FONT;
    var tw = ctx.measureText(String(str)).width, pw = tw + size * 1.5, ph = size * 1.9, px = x - pw / 2, py = y - ph / 2 - (1 - a) * 12 * U;
    if (o.to) {
      ctx.strokeStyle = K.alpha(o.color || '#ffffff', 0.85); ctx.lineWidth = 2.5 * U; ctx.beginPath(); ctx.moveTo(x, py + ph / 2); ctx.lineTo(K.lerp(x, o.to.x, a), K.lerp(py + ph / 2, o.to.y, a)); ctx.stroke();
      ctx.fillStyle = o.color || '#ffffff'; ctx.beginPath(); ctx.arc(o.to.x, o.to.y, 5 * U * a, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 16 * U; ctx.shadowOffsetY = 4 * U;
    K.roundRect(px, py, pw, ph, ph / 2, o.bg || 'rgba(12,18,28,0.88)');
    ctx.shadowColor = 'transparent';
    K.roundRect(px, py, pw, ph, ph / 2, null, K.alpha(o.color || '#ffffff', 0.55));
    ctx.fillStyle = o.color || '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(str), x, py + ph / 2 + size * 0.04);
    ctx.restore();
  };

  // ---------- isometric world ----------
  // x runs down-right, y runs down-left, z is up. One world unit = unit pixels.
  K.iso = function (o) {
    o = o || {};
    var ox = (o.originX === undefined ? 0.5 : o.originX) * w, oy = (o.originY === undefined ? 0.5 : o.originY) * h, S = (o.unit || 60) * U;
    var CX = 0.8660254, CY = 0.5;
    var I = { unit: S };
    I.pt = function (x, y, z) { return { x: ox + (x - y) * S * CX, y: oy + (x + y) * S * CY - (z || 0) * S }; };
    function face(points, color, light, stroke) {
      color = lit(color);
      var a = points[0], b = points[2];
      var g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0, K.shade(color, light + 0.05)); g.addColorStop(1, K.shade(color, light - 0.07));
      poly(points, g, stroke === false ? null : K.shade(color, light + 0.22), 1.6 * U);
    }
    // soft contact shadow on the ground under a footprint
    I.shadow = function (x, y, dx, dy, alpha, z) {
      var c = I.pt(x + dx / 2 + 0.25, y + dy / 2 + 0.25, z || 0), rx = (dx + dy) / 2 * S * CX * 1.15, ry = (dx + dy) / 2 * S * CY * 1.15;
      ctx.save(); ctx.translate(c.x, c.y); ctx.scale(1, ry / rx);
      var g = ctx.createRadialGradient(0, 0, rx * 0.2, 0, 0, rx); g.addColorStop(0, 'rgba(0,0,0,' + (alpha === undefined ? 0.32 : alpha) + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    };
    // flat tile on the ground (or at height z): land, platforms, roads, lawns
    I.tile = function (x, y, dx, dy, color, t) {
      t = t || {};
      var z = t.z || 0;
      face([I.pt(x, y, z), I.pt(x + dx, y, z), I.pt(x + dx, y + dy, z), I.pt(x, y + dy, z)], color, t.light === undefined ? 0.08 : t.light, t.stroke);
      if (t.grid) {
        ctx.save(); ctx.strokeStyle = K.alpha(K.shade(color, 0.4), 0.22); ctx.lineWidth = 1 * U; ctx.beginPath();
        for (var i = 1; i < dx; i++) { var a = I.pt(x + i, y, z), b = I.pt(x + i, y + dy, z); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
        for (var j = 1; j < dy; j++) { var c = I.pt(x, y + j, z), d = I.pt(x + dx, y + j, z); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); }
        ctx.stroke(); ctx.restore();
      }
    };
    // lit solid block: top bright, left mid, right dark
    I.box = function (x, y, z, dx, dy, dz, color, t) {
      t = t || {};
      ctx.save(); if (t.alpha !== undefined) ctx.globalAlpha *= t.alpha;
      face([I.pt(x, y + dy, z + dz), I.pt(x + dx, y + dy, z + dz), I.pt(x + dx, y + dy, z), I.pt(x, y + dy, z)], t.left || color, -0.1, t.stroke);
      face([I.pt(x + dx, y, z + dz), I.pt(x + dx, y + dy, z + dz), I.pt(x + dx, y + dy, z), I.pt(x + dx, y, z)], t.right || color, -0.3, t.stroke);
      face([I.pt(x, y, z + dz), I.pt(x + dx, y, z + dz), I.pt(x + dx, y + dy, z + dz), I.pt(x, y + dy, z + dz)], t.top || color, 0.16, t.stroke);
      ctx.restore();
    };
    function ellipse(c, r) { ctx.beginPath(); ctx.ellipse(c.x, c.y, r * S * 1.2247, r * S * 0.7071, 0, 0, Math.PI * 2); }
    // upright cylinder: tanks, towers, silos, drums, columns. level 0..1 shows liquid inside an open or glass vessel
    I.cyl = function (x, y, z, r, hgt, color, t) {
      t = t || {};
      color = lit(color);
      var b = I.pt(x, y, z), top = I.pt(x, y, z + hgt), rx = r * S * 1.2247, ry = r * S * 0.7071;
      ctx.save(); if (t.alpha !== undefined) ctx.globalAlpha *= t.alpha;
      function wall(c1, c2, col, a) {
        var g = ctx.createLinearGradient(c1.x - rx, 0, c1.x + rx, 0);
        g.addColorStop(0, K.alpha(K.shade(col, 0.05), a)); g.addColorStop(0.35, K.alpha(K.shade(col, 0.22), a)); g.addColorStop(1, K.alpha(K.shade(col, -0.38), a));
        ctx.beginPath(); ctx.ellipse(c2.x, c2.y, rx, ry, 0, 0, Math.PI, false); ctx.lineTo(c1.x - rx, c1.y); ctx.ellipse(c1.x, c1.y, rx, ry, 0, Math.PI, 0, true); ctx.closePath();
        ctx.fillStyle = g; ctx.fill();
      }
      var glass = t.glass === true, hasLevel = t.level !== undefined;
      wall(top, b, color, glass ? 0.28 : 1);
      if (hasLevel && (glass || t.open)) {
        var lv = K.clamp(t.level), lt = I.pt(x, y, z + hgt * lv), liquid = t.liquid || '#3aa6ff';
        if (glass && lv > 0) wall(lt, b, liquid, 0.82);
        if (t.open || glass) {
          if (!glass) { ellipse(top, r); ctx.fillStyle = K.shade(color, -0.55); ctx.fill(); }
          if (lv > 0) {
            ctx.save(); ellipse(top, r); if (!glass) ctx.clip();
            ctx.beginPath(); ctx.ellipse(lt.x, lt.y, rx * (glass ? 1 : 0.94), ry * (glass ? 1 : 0.94), 0, 0, Math.PI * 2);
            var lg = ctx.createLinearGradient(lt.x - rx, lt.y, lt.x + rx, lt.y); lg.addColorStop(0, K.shade(liquid, 0.3)); lg.addColorStop(1, K.shade(liquid, -0.12));
            ctx.fillStyle = lg; ctx.fill(); ctx.restore();
          }
        }
      }
      if (!(hasLevel && t.open && !glass)) { ellipse(top, r); ctx.fillStyle = glass ? K.alpha(K.shade(color, 0.3), 0.22) : K.shade(color, 0.26); ctx.fill(); }
      ellipse(top, r); ctx.strokeStyle = K.alpha(K.shade(color, 0.5), glass ? 0.7 : 0.55); ctx.lineWidth = 2 * U; ctx.stroke();
      ctx.restore();
    };
    // cone or dome-like cap on top of things: roofs of towers, funnels (flip), hills
    I.cone = function (x, y, z, r, hgt, color) {
      color = lit(color);
      var b = I.pt(x, y, z), tip = I.pt(x, y, z + hgt), rx = r * S * 1.2247, ry = r * S * 0.7071;
      var g = ctx.createLinearGradient(b.x - rx, 0, b.x + rx, 0); g.addColorStop(0, K.shade(color, 0.12)); g.addColorStop(0.4, K.shade(color, 0.26)); g.addColorStop(1, K.shade(color, -0.36));
      ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(b.x + rx, b.y); ctx.ellipse(b.x, b.y, rx, ry, 0, 0, Math.PI, false); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    };
    // four-sided mountain or pitched block; snow 0..1 caps the peak
    I.pyramid = function (x, y, z, dx, dy, hgt, color, t) {
      t = t || {};
      color = lit(color);
      var tip = I.pt(x + dx / 2, y + dy / 2, z + hgt), a = I.pt(x, y + dy, z), b = I.pt(x + dx, y + dy, z), c = I.pt(x + dx, y, z);
      function side(p, q, light) {
        var g = ctx.createLinearGradient(tip.x, tip.y, (p.x + q.x) / 2, (p.y + q.y) / 2); g.addColorStop(0, K.shade(color, light + 0.12)); g.addColorStop(1, K.shade(color, light - 0.1));
        poly([tip, p, q], g, K.shade(color, light + 0.2), 1.4 * U);
      }
      side(a, b, -0.04); side(b, c, -0.3);
      if (t.snow) {
        var s = K.clamp(t.snow) * 0.42, m = function (p) { return { x: K.lerp(tip.x, p.x, s), y: K.lerp(tip.y, p.y, s) }; };
        var a2 = m(a), b2 = m(b), c2 = m(c), snow = t.snowColor || '#f3f8ff';
        poly([tip, a2, { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 + 8 * U }, b2], K.shade(snow, -0.02));
        poly([tip, b2, { x: (b2.x + c2.x) / 2, y: (b2.y + c2.y) / 2 + 8 * U }, c2], K.shade(snow, -0.18));
      }
    };
    // gabled roof sitting on a box footprint
    I.roof = function (x, y, z, dx, dy, hgt, color) {
      var r1 = I.pt(x + dx / 2, y, z + hgt), r2 = I.pt(x + dx / 2, y + dy, z + hgt);
      face([I.pt(x, y, z), r1, r2, I.pt(x, y + dy, z)], color, 0.14);
      face([r1, I.pt(x + dx, y, z), I.pt(x + dx, y + dy, z), r2], color, -0.22);
      poly([I.pt(x, y + dy, z), r2, I.pt(x + dx, y + dy, z)], K.shade(color, -0.34), K.shade(color, -0.1), 1.4 * U);
    };
    // small house; lit 0..1 turns the windows on
    I.house = function (x, y, z, size, t) {
      t = t || {};
      var wallC = t.wall || '#e8e2d6', s = size;
      I.shadow(x, y, s, s, 0.26, z);
      I.box(x, y, z, s, s, s * 0.7, wallC);
      I.roof(x - s * 0.06, y - s * 0.06, z + s * 0.7, s * 1.12, s * 1.12, s * 0.5, t.roof || '#d9634a');
      var lit = K.clamp(t.lit === undefined ? 0 : t.lit), win = K.mix('#2b3a4d', t.glow || '#ffd774', lit);
      face([I.pt(x + s * 0.2, y + s, z + s * 0.5), I.pt(x + s * 0.45, y + s, z + s * 0.5), I.pt(x + s * 0.45, y + s, z + s * 0.25), I.pt(x + s * 0.2, y + s, z + s * 0.25)], win, 0, false);
      face([I.pt(x + s, y + s * 0.3, z + s * 0.5), I.pt(x + s, y + s * 0.6, z + s * 0.5), I.pt(x + s, y + s * 0.6, z + s * 0.25), I.pt(x + s, y + s * 0.3, z + s * 0.25)], win, -0.12, false);
      face([I.pt(x + s * 0.6, y + s, z + s * 0.42), I.pt(x + s * 0.8, y + s, z + s * 0.42), I.pt(x + s * 0.8, y + s, z), I.pt(x + s * 0.6, y + s, z)], t.door || '#5a4336', 0, false);
      if (lit > 0.05) { var gp = I.pt(x + s * 0.33, y + s, z + s * 0.38); K.glow(gp.x, gp.y, s * S * 0.5, t.glow || '#ffd774', 0.28 * lit); }
    };
    I.tree = function (x, y, z, size, color, sway) {
      var s = size, c = color || '#3f9d5b', k = (sway || 0) * 0.05 * s;
      I.shadow(x - s * 0.3, y - s * 0.3, s * 0.6, s * 0.6, 0.24, z);
      I.cyl(x, y, z, s * 0.07, s * 0.4, '#7a5a3c');
      I.cone(x + k * 0.4, y, z + s * 0.3, s * 0.36, s * 0.6, K.shade(c, -0.12));
      I.cone(x + k * 0.7, y, z + s * 0.62, s * 0.28, s * 0.52, c);
      I.cone(x + k, y, z + s * 0.92, s * 0.19, s * 0.42, K.shade(c, 0.12));
    };
    // puffy cloud floating at height z; drift it by changing x
    I.cloud = function (x, y, z, size, color, alpha) {
      var c = I.pt(x, y, z), r = size * S * 0.5, col = color || '#ffffff';
      ctx.save(); ctx.globalAlpha *= alpha === undefined ? 0.95 : alpha;
      var parts = [[-0.9, 0.1, 0.55], [-0.35, -0.22, 0.75], [0.3, -0.3, 0.85], [0.9, 0.05, 0.6], [0, 0.18, 0.8]];
      ctx.fillStyle = K.shade(col, -0.16); ctx.beginPath();
      for (var i = 0; i < parts.length; i++) { ctx.moveTo(c.x + parts[i][0] * r + parts[i][2] * r, c.y + parts[i][1] * r + r * 0.16); ctx.arc(c.x + parts[i][0] * r, c.y + parts[i][1] * r + r * 0.16, parts[i][2] * r, 0, Math.PI * 2); }
      ctx.fill();
      var g = ctx.createLinearGradient(0, c.y - r, 0, c.y + r); g.addColorStop(0, K.shade(col, 0.1)); g.addColorStop(1, K.shade(col, -0.08));
      ctx.fillStyle = g; ctx.beginPath();
      for (var j = 0; j < parts.length; j++) { ctx.moveTo(c.x + parts[j][0] * r + parts[j][2] * r, c.y + parts[j][1] * r); ctx.arc(c.x + parts[j][0] * r, c.y + parts[j][1] * r, parts[j][2] * r, 0, Math.PI * 2); }
      ctx.fill(); ctx.restore();
    };
    // flat water surface with moving glints: lakes, basins, rivers. Raise z over time to fill something
    I.water = function (x, y, z, dx, dy, color, t, o) {
      o = o || {};
      var pts = [I.pt(x, y, z), I.pt(x + dx, y, z), I.pt(x + dx, y + dy, z), I.pt(x, y + dy, z)], col = color || '#2f9bff';
      var g = ctx.createLinearGradient(pts[0].x, pts[0].y, pts[2].x, pts[2].y); g.addColorStop(0, K.shade(col, 0.24)); g.addColorStop(1, K.shade(col, -0.14));
      poly(pts, g, K.alpha(K.shade(col, 0.5), 0.7), 1.6 * U);
      ctx.save(); ctx.beginPath(); for (var i = 0; i < 4; i++) { if (i === 0) ctx.moveTo(pts[i].x, pts[i].y); else ctx.lineTo(pts[i].x, pts[i].y); } ctx.closePath(); ctx.clip();
      ctx.strokeStyle = K.alpha('#ffffff', 0.38); ctx.lineWidth = 2.2 * U; ctx.lineCap = 'round';
      var n = o.glints === undefined ? Math.max(4, Math.round(dx * dy * 0.9)) : o.glints;
      for (var k = 0; k < n; k++) {
        var px = x + K.rand(k * 3.1 + 1) * dx, py = y + K.loop(t || 0, 5 + K.rand(k) * 4, K.rand(k * 7.7)) * dy, len = 0.25 + K.rand(k * 5.3) * 0.5;
        var a = I.pt(px, py, z), b = I.pt(px + len, py, z);
        ctx.globalAlpha = 0.25 + 0.6 * Math.abs(K.wave(t || 0, 2.4, K.rand(k * 9.1)));
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.restore();
    };
    // expanding rings where something lands on a surface
    I.ripple = function (x, y, z, radius, t, color, period) {
      for (var i = 0; i < 3; i++) {
        var u = K.loop(t, period || 1.6, i / 3), c = I.pt(x, y, z);
        ctx.strokeStyle = K.alpha(color || '#ffffff', (1 - u) * 0.7); ctx.lineWidth = 2.2 * U;
        ctx.beginPath(); ctx.ellipse(c.x, c.y, radius * u * S * 1.2247, radius * u * S * 0.7071, 0, 0, Math.PI * 2); ctx.stroke();
      }
    };
    function along(points, u) {
      var p = points.map(function (q) { return I.pt(q[0], q[1], q[2] || 0); }), total = 0, seg = [];
      for (var i = 1; i < p.length; i++) { var d = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); seg.push(d); total += d; }
      var want = K.clamp(u) * total;
      for (var j = 0; j < seg.length; j++) { if (want <= seg[j] || j === seg.length - 1) { var f = seg[j] ? want / seg[j] : 0; return { x: K.lerp(p[j].x, p[j + 1].x, f), y: K.lerp(p[j].y, p[j + 1].y, f), total: total, pts: p }; } want -= seg[j]; }
      return { x: p[0].x, y: p[0].y, total: total, pts: p };
    }
    I.along = along;
    // round pipe through world points [[x,y,z],...]. fill 0..1 runs liquid through it from the first point
    I.pipe = function (points, radius, color, t) {
      t = t || {};
      var p = points.map(function (q) { return I.pt(q[0], q[1], q[2] || 0); }), wd = radius * S * 2;
      function trace(upTo) {
        ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y);
        if (upTo === undefined) { for (var i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y); return; }
        var total = along(points, 1).total, want = K.clamp(upTo) * total;
        for (var j = 1; j < p.length; j++) { var d = Math.hypot(p[j].x - p[j - 1].x, p[j].y - p[j - 1].y); if (want >= d) { ctx.lineTo(p[j].x, p[j].y); want -= d; } else { var f = d ? want / d : 0; ctx.lineTo(K.lerp(p[j - 1].x, p[j].x, f), K.lerp(p[j - 1].y, p[j].y, f)); break; } }
      }
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      trace(); ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = wd * 1.25; ctx.save(); ctx.translate(wd * 0.25, wd * 0.5); ctx.stroke(); ctx.restore();
      trace(); ctx.strokeStyle = K.shade(color, -0.32); ctx.lineWidth = wd; ctx.stroke();
      trace(); ctx.strokeStyle = color; ctx.lineWidth = wd * 0.72; ctx.save(); ctx.translate(-wd * 0.06, -wd * 0.1); ctx.stroke(); ctx.restore();
      if (t.fill !== undefined && t.fill > 0) {
        trace(t.fill); ctx.strokeStyle = t.liquid || '#3aa6ff'; ctx.lineWidth = wd * 0.5; ctx.stroke();
        if (t.t !== undefined) {
          trace(t.fill); ctx.strokeStyle = K.alpha('#ffffff', 0.55); ctx.lineWidth = wd * 0.2; ctx.setLineDash([wd * 0.9, wd * 1.5]); ctx.lineDashOffset = -(t.t * (t.speed || 1) * wd * 3.2); ctx.stroke(); ctx.setLineDash([]);
        }
      }
      trace(); ctx.strokeStyle = K.alpha('#ffffff', 0.3); ctx.lineWidth = wd * 0.14; ctx.save(); ctx.translate(-wd * 0.2, -wd * 0.3); ctx.stroke(); ctx.restore();
      ctx.restore();
    };
    // dots travelling along a path: flow of water, goods, signals, traffic. reach 0..1 limits how far they get
    I.flow = function (points, t, o) {
      o = o || {};
      var n = o.count || 8, reach = o.reach === undefined ? 1 : K.clamp(o.reach), r = (o.size || 7) * U;
      for (var i = 0; i < n; i++) {
        var u = K.loop(t, o.period || 3, i / n); if (u > reach) continue;
        var q = along(points, u), fade = Math.min(1, u * 8, (reach - u) * 8 + 0.2);
        K.glow(q.x, q.y, r * 2.6, o.color || '#7fd0ff', 0.3 * fade);
        ctx.fillStyle = K.alpha(o.color || '#7fd0ff', fade); ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill();
      }
    };
    // streaks falling through a volume: rain, sparks (use a negative speed to rise), snow, steam
    I.drops = function (x, y, z, dx, dy, height, t, o) {
      o = o || {};
      var n = o.count || 60, sp = o.speed || 1, len = (o.length || 0.5) * S;
      ctx.save(); ctx.strokeStyle = o.color || 'rgba(170,215,255,0.8)'; ctx.lineWidth = (o.width || 2.4) * U; ctx.lineCap = 'round';
      for (var i = 0; i < n; i++) {
        var u = K.loop(t * sp, 0.9 + K.rand(i * 2.3) * 0.7, K.rand(i * 4.1 + (o.seed || 0)));
        var p = I.pt(x + K.rand(i * 1.7 + 3) * dx, y + K.rand(i * 3.3 + 5) * dy, z + height * (1 - u));
        ctx.globalAlpha = (o.alpha === undefined ? 0.85 : o.alpha) * Math.min(1, u * 6, (1 - u) * 6);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y + len); ctx.stroke();
      }
      ctx.restore();
    };
    // spinning wheel lying flat at height z: filters, fans, turbines, gears, mixers
    I.rotor = function (x, y, z, r, angle, color, o) {
      o = o || {};
      var c = I.pt(x, y, z), blades = o.blades || 6;
      ctx.save(); ctx.translate(c.x, c.y); ctx.scale(1.2247, 0.7071);
      ctx.beginPath(); ctx.arc(0, 0, r * S, 0, Math.PI * 2); ctx.fillStyle = K.shade(color, -0.42); ctx.fill();
      for (var i = 0; i < blades; i++) {
        var a = angle + i * Math.PI * 2 / blades;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r * S * 0.92, a, a + Math.PI / blades * (o.gap === undefined ? 1 : o.gap)); ctx.closePath();
        ctx.fillStyle = i % 2 ? K.shade(color, 0.18) : color; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(0, 0, r * S * 0.2, 0, Math.PI * 2); ctx.fillStyle = K.shade(color, 0.45); ctx.fill();
      ctx.beginPath(); ctx.arc(0, 0, r * S, 0, Math.PI * 2); ctx.strokeStyle = K.shade(color, 0.4); ctx.lineWidth = 3 * U; ctx.stroke();
      ctx.restore();
    };
    // arrow that draws itself along a path; progress 0..1
    I.arrow = function (points, color, progress, width) {
      var u = K.clamp(progress === undefined ? 1 : progress); if (u <= 0) return;
      var head = along(points, u), tail = along(points, Math.max(0, u - 0.04)), ang = Math.atan2(head.y - tail.y, head.x - tail.x), wd = (width || 7) * U;
      ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = wd; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); var steps = 40; for (var i = 0; i <= steps; i++) { var q = along(points, u * i / steps); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); } ctx.stroke();
      ctx.translate(head.x, head.y); ctx.rotate(ang); ctx.beginPath(); ctx.moveTo(wd * 2.6, 0); ctx.lineTo(-wd * 1.2, -wd * 1.9); ctx.lineTo(-wd * 1.2, wd * 1.9); ctx.closePath(); ctx.fill();
      ctx.restore();
    };
    // label pinned above a world point, with a leader line down to it
    I.label = function (str, x, y, z, o) {
      o = o || {};
      var p = I.pt(x, y, z), lift = (o.lift === undefined ? 1.6 : o.lift) * S;
      K.label(str, p.x + (o.dx || 0) * S, p.y - lift, { to: p, color: o.color, bg: o.bg, size: o.size, appear: o.appear });
    };
    return I;
  };
  return K;
}
`

/** The reference the author model reads. Keep in step with CANVAS_KIT_SOURCE. */
export const CANVAS_KIT_GUIDE = `An art kit is available as the variable kit (already built for this frame). Compose the scene from it instead of hand-drawing projection maths; raw ctx calls remain available for anything it lacks.

TIME AND MOTION
kit.prog(t,start,end,ease?) -> eased 0..1 while t goes start..end ('inOut' default; 'in','out','back','bounce','linear'). Stage every beat with it.
kit.loop(t,period,phase?) -> repeating 0..1; kit.wave(t,period,phase?) -> -1..1; kit.rand(seed) -> fixed 0..1; kit.lerp(a,b,u); kit.clamp(x,a,b).
COLOUR
kit.shade(color,amount -1..1), kit.alpha(color,a), kit.mix(a,b,u).
FRAME
kit.bg(topColor,bottomColor,{glowX,glowY,glowColor,glowAlpha}) paints the whole backdrop (call first).
kit.title(headline,subline,{appear,accent}) top-left headline; kit.label(text,x,y,{to:{x,y},appear,color}) pill with leader line; kit.text(str,x,y,{size,weight,color,align}); kit.glow(x,y,r,color,alpha).
ISOMETRIC WORLD
const iso = kit.iso({originX:0.5,originY:0.6,unit:60}) — origin is where world (0,0,0) sits as a fraction of the frame; unit is pixels per world unit at 1080p. x runs down-right, y runs down-left, z is up. A landscape frame comfortably shows about x,y in -8..8.
DRAW BACK TO FRONT: things with smaller x+y first, then larger x+y; ground before what stands on it; lower z before higher.
iso.pt(x,y,z) -> {x,y} screen point.
iso.tile(x,y,dx,dy,color,{z,grid:true}) ground, platforms, roads.
iso.box(x,y,z,dx,dy,dz,color,{alpha}) lit block (buildings, machines, steps).
iso.cyl(x,y,z,r,height,color,{open:true,level:0..1,liquid}) tank/tower/drum; open+level shows liquid inside from above; {glass:true,level,liquid} is a see-through vessel (a drinking glass, a gauge).
iso.cone(x,y,z,r,height,color); iso.pyramid(x,y,z,dx,dy,height,color,{snow:0..1}) mountains; iso.roof(x,y,z,dx,dy,height,color).
iso.house(x,y,z,size,{wall,roof,lit:0..1}); iso.tree(x,y,z,size,color,sway); iso.cloud(x,y,z,size,color,alpha).
iso.water(x,y,z,dx,dy,color,t) shimmering surface — raise z with kit.prog to fill a basin; iso.ripple(x,y,z,radius,t,color).
iso.pipe([[x,y,z],...],radius,color,{fill:0..1,liquid,t}) pipe with liquid advancing from the first point; iso.flow([[x,y,z],...],t,{count,color,size,period,reach:0..1}) glowing dots travelling a path.
iso.drops(x,y,z,dx,dy,height,t,{count,color,speed,length}) rain or particles falling through a volume.
iso.rotor(x,y,z,r,angle,color,{blades}) wheel spinning flat (angle = t*speed); iso.arrow(points,color,progress); iso.shadow(x,y,dx,dy,alpha) contact shadow (draw before the object).
iso.label(text,x,y,z,{appear,lift,dx}) label pinned above a world point.

kit.colors has materials that read well: land, grass, sand, rock, snow, concrete, steel, dark, water, glass, wood, roof, wall, warm, hot, leaf, cloud.

CRAFT RULES
- Colour: the supplied palette's background colours are for kit.bg only. Objects are lit: paint them in bright, saturated mid-tones (kit.colors, or the palette's accent colours) so they stand clear of the dark backdrop. Never paint land, walls or machines in near-black or in the backdrop colour.
- Stage: build the world on ONE ground slab, centred — iso.box(-7,-7,-0.5,14,14,0.5,kit.colors.land) then iso.tile(-7,-7,14,14,kit.colors.grass or land,{grid:true}) — and stand everything on it, inside its edges. Do not sink things below z=0 or leave them floating beside the slab.
- Layout: the main subject sits at the centre and fills 60-80% of the frame, built from several kit solids so it reads as a real object. Tall scenery (mountains, towers that are not the subject) goes in the back corner only (negative x and negative y); nothing tall stands in front of the subject (large positive x+y).
- Physics: every solid has a shadow under it; pipes and flows physically connect the outlet of one thing to the inlet of the next; liquid stays inside its vessel (use iso.water inside walls drawn after it, or iso.cyl with level).
- Use the kit for rain, flow, ripples, labels and titles rather than hand-drawing them.
- Beats: stage the scene with kit.prog — establish by 20% of the duration, main action 20-80%, payoff and hold at the end. Something clearly changes across the whole scene (a level rises, a flow advances, lights come on), not only small looping details.
- Keep the lower 22% of the frame free of key content because captions sit there. Start with kit.title(scene headline, scene subline,{appear:kit.prog(t,0.2,1)}) unless the scene has no headline.

EXAMPLE (a reservoir filling in the rain — follow this structure, not this subject):
kit.bg('#0b2233','#06121c',{glowX:0.55,glowY:0.45,glowColor:'#3aa6ff',glowAlpha:0.14});
const iso=kit.iso({originX:0.52,originY:0.5,unit:58}), C=kit.colors, fill=kit.prog(t,1.2,6.5);
iso.shadow(-7,-7,14,14,0.4); iso.box(-7,-7,-0.5,14,14,0.5,C.land); iso.tile(-7,-7,14,14,C.land,{grid:true});
iso.pyramid(-7,-7,0,6,6,5.2,C.rock,{snow:0.9}); iso.pyramid(-2.5,-7.2,0,4.5,4.5,3.6,C.rock,{snow:0.6});
iso.box(-2.2,-2.2,0,6.4,6.4,0.35,C.concrete); iso.water(-1.8,-1.8,0.04+fill,5.6,5.6,C.water,t);
iso.box(-2.2,3.8,0,6.4,0.5,1.5,C.concrete); iso.box(3.8,-2.2,0,0.5,6.5,1.5,C.concrete);
for(let i=0;i<4;i++) iso.ripple(-1+kit.rand(i)*4,-1+kit.rand(i+9)*4,0.05+fill,0.7,t+i*0.4,'#d5efff');
iso.tree(-5.5,3.5,0,1.6,C.leaf,kit.wave(t,3)); iso.tree(5.6,5.6,0,1.8,C.grass,kit.wave(t,3.1,0.1));
iso.pipe([[4.3,1,0.5],[6.6,1,0.5],[6.6,4.5,0.5]],0.2,C.steel,{fill:kit.prog(t,5.2,7.4),liquid:C.water,t});
iso.drops(-2,-2,1.2,6,6,5.2,t,{count:90,speed:1.2}); iso.cloud(-1.5+kit.wave(t,9)*0.6,-1.5,7.4,3.2,C.cloud); iso.cloud(2.2,0.5,7.9,2.6,C.cloud,0.9);
kit.title('Mountain reservoir','Rain fills the catchment basin',{appear:kit.prog(t,0.2,1),accent:C.water});
iso.label('Water level '+Math.round(fill*100)+'%',1,1,1.2+fill,{appear:kit.prog(t,1.4,2.2),lift:2.4,dx:3.6});`
