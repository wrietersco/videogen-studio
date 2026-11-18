import { readFileSync } from 'node:fs'
import { renderSceneHtml } from '../appRecon/scenes'

/**
 * The product scene: the business's own product photo, animated. The photo
 * sits on a rounded card with a soft glow and a shadow on the brand
 * backdrop, enters with a rise, a turn or a slide, then floats while the
 * picture inside slowly pushes in. A light sweeps across it once, the logo
 * sits on the card as a small badge, and the product's name and one short
 * benefit line come in beside it (below it on a tall film). A cut-out
 * picture (clear background) floats on its own with a drop shadow instead
 * of a card. Up to two more photos of the same product fan out behind.
 *
 * Like the other scenes, every frame is a pure function of time through
 * window.__seek(t), so the same input always renders the same film.
 */

export type ProductEntrance = 'rise' | 'turn' | 'slide'

export interface ProductSceneInput {
  /** the product photos, the first is the hero (at most 3 are shown) */
  images: string[]
  /** the product or service name */
  name: string
  /** one short benefit line */
  line?: string
  /** a small label above the name */
  pill?: string
  /** hex without '#', default 4f8cff */
  accent?: string
  /** two CSS colours for the backdrop gradient */
  backdrop?: [string, string]
  /** the logo for dark backgrounds (PNG) */
  logo?: string
  durationSec: number
  size?: { width: number; height: number }
  entrance?: ProductEntrance
  /** the hero is a cut-out with a clear background: no card around it */
  cutout?: boolean
  /** the text side: 'side' (default on a wide film) or 'none' when the scene is one shot in a montage under other captions */
  text?: 'side' | 'none'
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const safeColor = (c: string | undefined, fallback: string): string => (c && /^[#a-zA-Z0-9(),.%\s-]{3,60}$/.test(c) ? c : fallback)
const hexRgb = (hex: string): [number, number, number] => {
  const h = /^[0-9a-f]{6}$/i.test(hex) ? hex : '4f8cff'
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
const mix = (a: number[], b: number[], k: number): string => `rgb(${[0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k)).join(',')})`

/** a picture as a data address, made smaller first so the page stays light */
async function pictureData(file: string, edge: number): Promise<{ src: string; w: number; h: number } | null> {
  try {
    const sharp = (await import('sharp')).default
    const png = /\.png$/i.test(file)
    const img = sharp(readFileSync(file)).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    const { data, info } = png ? await img.png().toBuffer({ resolveWithObject: true }) : await img.jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true })
    return { src: `data:image/${png ? 'png' : 'jpeg'};base64,${data.toString('base64')}`, w: info.width, h: info.height }
  } catch {
    return null
  }
}

/** the scene page; the pictures are passed in already read */
export function productSceneHtml(inp: ProductSceneInput, pics: Array<{ src: string; w: number; h: number }>, logo: string | null): string {
  const W = inp.size?.width ?? 1920
  const H = inp.size?.height ?? 1080
  const tall = H > W
  const rgb = hexRgb((inp.accent ?? '4f8cff').replace('#', ''))
  const light = mix(rgb, [255, 255, 255], 0.45)
  const b0 = safeColor(inp.backdrop?.[0], mix(rgb, [0, 0, 0], 0.86))
  const b1 = safeColor(inp.backdrop?.[1], mix(rgb, [0, 0, 0], 0.66))
  const ac = (a: number): string => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`
  const withText = inp.text !== 'none'
  // where the card sits and how big it may be
  const cx = withText ? (tall ? W / 2 : W * 0.32) : W / 2
  const cy = withText ? (tall ? H * 0.37 : H * 0.5) : H * 0.5
  const maxW = withText ? (tall ? W * 0.78 : W * 0.4) : W * (tall ? 0.8 : 0.5)
  const maxH = withText ? (tall ? H * 0.42 : H * 0.68) : H * (tall ? 0.56 : 0.74)
  const hero = pics[0]
  const aspect = Math.min(1.45, Math.max(0.78, hero.w / Math.max(1, hero.h)))
  const cw = Math.round(Math.min(maxW, maxH * aspect))
  const ch = Math.round(cw / aspect)
  const radius = Math.round(Math.min(cw, ch) * 0.06)
  const nameLen = inp.name.length
  const nameSize = Math.round((tall ? W / 12.5 : W / 22) * (nameLen > 28 ? 0.72 : nameLen > 18 ? 0.86 : 1))
  const lineSize = Math.round(tall ? W / 26 : W / 48)
  const textBox = tall
    ? `left:${Math.round(W * 0.08)}px;width:${Math.round(W * 0.84)}px;top:${Math.round(H * 0.63)}px;text-align:center;align-items:center`
    : `left:${Math.round(W * 0.56)}px;width:${Math.round(W * 0.37)}px;top:0;height:${H}px;justify-content:center;text-align:left;align-items:flex-start`
  const cfg = {
    W, H, T: Math.max(0.5, inp.durationSec), cx, cy, cw, ch,
    entrance: inp.entrance ?? 'rise',
    cutout: !!inp.cutout,
    extras: pics.length - 1,
    tall
  }
  const sides = pics.slice(1, 3).map((p, i) => `<div class="side" id="side${i}"><img src="${p.src}" alt=""></div>`).join('')
  const dots = Array.from({ length: 9 }, (_, i) => `<div class="dot" id="dot${i}"></div>`).join('')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>product</title>
<style>
html,body{margin:0;padding:0;width:${W}px;height:${H}px;overflow:hidden;background:${b0}}
#bg{position:absolute;left:-60px;top:-60px;width:${W + 120}px;height:${H + 120}px;background:radial-gradient(ellipse at ${Math.round((cx / W) * 100)}% ${Math.round((cy / H) * 100)}%,${ac(0.32)} 0%,rgba(0,0,0,0) 46%),linear-gradient(135deg,${b0},${b1})}
.dot{position:absolute;border-radius:50%;background:${ac(0.22)};filter:blur(6px)}
#shadow{position:absolute;width:${Math.round(cw * 0.86)}px;height:${Math.round(ch * 0.12)}px;border-radius:50%;background:rgba(0,0,0,.55);filter:blur(${Math.round(cw * 0.05)}px)}
#glow{position:absolute;width:${Math.round(cw * 1.5)}px;height:${Math.round(ch * 1.5)}px;border-radius:50%;background:radial-gradient(ellipse at center,${ac(0.45)} 0%,rgba(0,0,0,0) 66%)}
#stage{position:absolute;left:0;top:0;width:${W}px;height:${H}px;perspective:${Math.round(W * 0.9)}px}
.side,#card{position:absolute;left:${Math.round(cx - cw / 2)}px;top:${Math.round(cy - ch / 2)}px;width:${cw}px;height:${ch}px;border-radius:${radius}px;overflow:hidden;transform-origin:50% 60%;will-change:transform,opacity}
#card{box-shadow:0 0 0 1.5px rgba(255,255,255,.14),0 30px 80px rgba(0,0,0,.45),0 0 90px ${ac(0.35)};background:#111}
.side{box-shadow:0 20px 60px rgba(0,0,0,.5);background:#111;filter:brightness(.72) saturate(.9)}
.side img,#card img{width:100%;height:100%;object-fit:cover;display:block;will-change:transform}
#card.cut{background:transparent;box-shadow:none;overflow:visible;border-radius:0}
#card.cut img{object-fit:contain;filter:drop-shadow(0 28px 36px rgba(0,0,0,.5)) drop-shadow(0 0 40px ${ac(0.35)})}
#shine{position:absolute;left:0;top:0;width:100%;height:100%;background:linear-gradient(105deg,rgba(255,255,255,0) 35%,rgba(255,255,255,.28) 50%,rgba(255,255,255,0) 65%);mix-blend-mode:screen;pointer-events:none}
#card.cut #shine{display:none}
#badge{position:absolute;right:${Math.round(cw * 0.05)}px;bottom:${Math.round(cw * 0.05)}px;padding:${Math.round(cw * 0.022)}px ${Math.round(cw * 0.035)}px;border-radius:${Math.round(cw * 0.03)}px;background:rgba(10,10,14,.62);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);box-shadow:0 6px 22px rgba(0,0,0,.35);display:flex;align-items:center}
#badge img{height:${Math.round(Math.max(28, cw * 0.075))}px;width:auto;max-width:${Math.round(cw * 0.36)}px;object-fit:contain}
#card.cut #badge{right:-${Math.round(cw * 0.04)}px;bottom:-${Math.round(cw * 0.02)}px}
#text{position:absolute;display:flex;flex-direction:column;${textBox};font-family:'Segoe UI','Segoe UI Variable','Noto Sans','Helvetica Neue',Arial,sans-serif;color:#fff;text-shadow:0 2px 22px rgba(0,0,0,.45)}
#text>*{will-change:transform,opacity}
#pill{font-size:${Math.round(lineSize * 0.62)}px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;padding:${Math.round(lineSize * 0.34)}px ${Math.round(lineSize * 0.9)}px;border-radius:999px;border:1.5px solid ${ac(0.7)};background:${ac(0.16)};color:${light};margin-bottom:${Math.round(lineSize * 0.9)}px;text-shadow:none}
#name{font-size:${nameSize}px;font-weight:800;line-height:1.05;letter-spacing:-.015em;text-wrap:balance;overflow-wrap:break-word}
#bar{height:${Math.max(4, Math.round(nameSize * 0.07))}px;width:${Math.round(nameSize * 2.2)}px;border-radius:9px;background:${light};margin:${Math.round(nameSize * 0.32)}px 0 ${Math.round(nameSize * 0.3)}px;transform-origin:${tall ? '50%' : '0'} 50%}
#line{font-size:${lineSize}px;font-weight:400;line-height:1.32;color:rgba(255,255,255,.86);text-wrap:balance;max-width:100%}
</style></head><body>
<div id="bg"></div>${dots}
<div id="glow"></div><div id="shadow"></div>
<div id="stage">${sides}<div id="card"${inp.cutout ? ' class="cut"' : ''}><img id="hero" src="${hero.src}" alt="">${inp.cutout ? '' : '<div id="shine"></div>'}${logo ? `<div id="badge"><img src="${logo}" alt=""></div>` : ''}</div></div>
${withText ? `<div id="text">${inp.pill ? `<div id="pill" dir="auto">${esc(inp.pill)}</div>` : ''}<div id="name" dir="auto">${esc(inp.name)}</div><div id="bar"></div>${inp.line ? `<div id="line" dir="auto">${esc(inp.line)}</div>` : ''}</div>` : ''}
<script>
const C=${JSON.stringify(cfg).replace(/</g, '\\u003c')};
${PRODUCT_JS}
</script></body></html>`
}

const PRODUCT_JS = String.raw`
(function(){
var T=C.T,$=function(id){return document.getElementById(id)};
function cl(x,a,b){return x<a?a:x>b?b:x}
function sg(t,a,b){return cl((t-a)/(b-a),0,1)}
function eo(x){return 1-Math.pow(1-x,3)}
function back(x){var c=1.5;return 1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2)}
function lp(a,b,k){return a+(b-a)*k}
var dots=[];for(var i=0;i<9;i++){var r=Math.sin(i*91.7)*43758.5453;r=r-Math.floor(r);var q=Math.sin(i*12.9+4)*9631.1;q=q-Math.floor(q);dots.push({x:r*C.W,y:q*C.H,s:30+((r*q*1000)%1)*90,sp:.4+q*.8,ph:r*6.28})}
function frame(t){
  t=cl(t,0,T);
  var u=t/T;
  /* the backdrop drifts against the card: a little depth */
  $('bg').style.transform='translate('+(-24*u)+'px,'+(-10*u)+'px) scale('+(1+.03*u)+')';
  for(var i=0;i<dots.length;i++){var d=dots[i],e=$('dot'+i);e.style.width=e.style.height=d.s+'px';e.style.left=(d.x+Math.sin(t*d.sp*.6+d.ph)*30-40*u*d.sp)+'px';e.style.top=(d.y+Math.cos(t*d.sp*.5+d.ph)*24)+'px';e.style.opacity=(.35+.35*Math.sin(t*d.sp+d.ph))*sg(t,0,.6)}
  /* the hero: enters, then floats */
  var k=sg(t,.05,1.05),e1=eo(k),bk=back(k);
  var fy=Math.sin(t*1.25)*C.ch*.012*sg(t,.9,1.6),rot=Math.sin(t*.8)*.7*sg(t,.9,1.6),ry=Math.sin(t*.55)*3.5*sg(t,.9,1.8);
  var tr='',op=e1;
  if(C.entrance==='turn'){tr='translateX('+lp(-C.cw*.18,0,e1)+'px) rotateY('+lp(-42,0,e1)+'deg) scale('+lp(.9,1,e1)+')'}
  else if(C.entrance==='slide'){tr='translateX('+lp(-C.W*.32,0,e1)+'px) rotate('+lp(-7,0,e1)+'deg)'}
  else{tr='translateY('+lp(C.ch*.22,0,bk)+'px) scale('+lp(.84,1,bk)+') rotate('+lp(3.5,0,e1)+'deg)'}
  var card=$('card');
  card.style.opacity=op;
  card.style.transform=tr+' translateY('+fy+'px) rotate('+rot+'deg) rotateY('+ry+'deg)';
  /* the photo inside slowly pushes in */
  $('hero').style.transform=C.cutout?'scale('+(1+.03*u)+')':'scale('+lp(1.12,1.0,eo(u))+') translateX('+lp(-C.cw*.015,C.cw*.015,u)+'px)';
  var sh=$('shine');if(sh){var s=sg(t,1.05,2.05);sh.style.opacity=s>0&&s<1?1:0;sh.style.transform='translateX('+lp(-120,120,s)+'%)'}
  var bd=$('badge');if(bd){var b=sg(t,1.0,1.5);bd.style.opacity=b;bd.style.transform='scale('+lp(.6,1,back(b))+')'}
  /* the shadow and the glow follow the card */
  var shd=$('shadow');shd.style.left=(C.cx-C.cw*.43)+'px';shd.style.top=(C.cy+C.ch*.5+C.ch*.04)+'px';shd.style.opacity=.55*e1*(1-fy/(C.ch*.05));shd.style.transform='scale('+(1-fy/C.ch*1.5)+',1)';
  var gl=$('glow');gl.style.left=(C.cx-C.cw*.75)+'px';gl.style.top=(C.cy-C.ch*.75)+'px';gl.style.opacity=e1*(.75+.25*Math.sin(t*1.1));
  /* more photos of the same product fan out behind */
  for(var j=0;j<C.extras&&j<2;j++){var el=$('side'+j);if(!el)continue;var a=eo(sg(t,.45+j*.18,1.35+j*.18)),dir=j===0?-1:1;
    /* on a wide film the words are on the right, so both fan out to the left (one higher, one lower) */
    var dx=C.tall?dir*C.cw*.30:-C.cw*(j===0?.34:.22),dy=C.tall?-C.ch*.04:C.ch*(j===0?.06:-.16);
    el.style.opacity=a*.95;el.style.transform='translate('+(dx*a)+'px,'+(dy*a+Math.sin(t*1.1+j)*4)+'px) scale(.74) rotate('+((C.tall?dir:-1)*(j===0?7:12)*a)+'deg)'}
  /* the words */
  var parts=[['pill',.45],['name',.62],['bar',.85],['line',.98]];
  for(var p=0;p<parts.length;p++){var n=$(parts[p][0]);if(!n)continue;var a2=eo(sg(t,parts[p][1],parts[p][1]+.55));
    if(parts[p][0]==='bar'){n.style.transform='scaleX('+a2+')';n.style.opacity=a2}else{n.style.opacity=a2;n.style.transform='translateY('+lp(26,0,a2)+'px)'}}
}
window.__seek=frame;
frame(0);
})();
`

/** renders the product scene to a silent video; `stills` also saves frames as PNGs (for checks and contact sheets) */
export async function renderProductScene(inp: ProductSceneInput, outFile: string, stills?: { at: number[]; dir: string }): Promise<{ file: string; durationSec: number; stills: string[] }> {
  const size = inp.size ?? { width: 1920, height: 1080 }
  const edge = Math.round(Math.max(size.width, size.height) * 0.75)
  const pics = (await Promise.all(inp.images.slice(0, 3).map((f, i) => pictureData(f, i === 0 ? edge : Math.round(edge * 0.6))))).filter((p): p is { src: string; w: number; h: number } => !!p)
  if (!pics.length) throw new Error('the product picture could not be read')
  let logo: string | null = null
  if (inp.logo) {
    try {
      logo = 'data:image/png;base64,' + readFileSync(inp.logo).toString('base64')
    } catch {
      logo = null
    }
  }
  return renderSceneHtml(productSceneHtml(inp, pics, logo), size, inp.durationSec, outFile, stills)
}
