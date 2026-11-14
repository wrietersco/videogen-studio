import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ffmpegBin } from '../audio/pcm'
import { launch } from './browser'

/**
 * Programmatic animated scenes for the launch film: title, "the problem" and
 * outro. Each is one self-contained page (inline CSS + canvas + JS, no network)
 * whose every frame is a pure function of time through window.__seek(t), so
 * the output is deterministic. renderScene steps through it frame by frame
 * and encodes a silent 1920x1080, 30 fps H.264 file.
 */

export type Motif = 'graph' | 'flow' | 'cards'

const GRAPH_WORDS = /graph|ontolog|network|relationship|relation|connect|link|map\b|mapping|knowledge|node|taxonomy|hierarch|topic|semantic|linked|web of|explor/i
const FLOW_WORDS = /workflow|work flow|pipeline|step|process|automat|approval|approve|stage|sequence|onboard|checkout|funnel|handoff|hand-off|schedul|queue|routing/i

export function pickMotif(text: string): Motif {
  const t = text || ''
  if (GRAPH_WORDS.test(t)) return 'graph'
  if (FLOW_WORDS.test(t)) return 'flow'
  return 'cards'
}

export interface SceneInput {
  kind: 'title' | 'problem' | 'outro'
  motif: Motif
  /** small label, e.g. NEW / THE PROBLEM / a call to action */
  pill?: string
  headline: string
  sub?: string
  /** hex without '#', default 4f8cff */
  accent?: string
  /** two CSS colours for the background gradient */
  backdrop?: [string, string]
  /** path to a PNG (transparent, for dark backgrounds) */
  logo?: string
  durationSec: number
  seed?: number
}

const FPS = 30

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function hexRgb(hex: string): [number, number, number] {
  const h = /^[0-9a-f]{6}$/i.test(hex) ? hex : '4f8cff'
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function mixRgb(a: number[], b: number[], k: number): [number, number, number] {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k)) as [number, number, number]
}

const cssRgb = (c: number[]): string => `rgb(${c[0]},${c[1]},${c[2]})`

/** CSS colours come from a brief: allow plain colour syntax only */
function safeColor(c: string | undefined, fallback: string): string {
  return c && /^[#a-zA-Z0-9(),.%\s-]{3,60}$/.test(c) ? c : fallback
}

function logoData(path?: string): string | null {
  if (!path) return null
  try {
    return 'data:image/png;base64,' + readFileSync(path).toString('base64')
  } catch {
    return null
  }
}

export function sceneHtml(inp: SceneInput): string {
  const rgb = hexRgb((inp.accent ?? '4f8cff').replace('#', ''))
  const light = mixRgb(rgb, [255, 255, 255], 0.45)
  const dark0 = cssRgb(mixRgb(rgb, [0, 0, 0], 0.88))
  const dark1 = cssRgb(mixRgb(rgb, [0, 0, 0], 0.7))
  const b0 = safeColor(inp.backdrop?.[0], dark0)
  const b1 = safeColor(inp.backdrop?.[1], dark1)
  const T = Math.max(0.5, inp.durationSec)
  const cfg = {
    kind: inp.kind,
    motif: inp.motif,
    t: T,
    seed: Math.floor(inp.seed ?? 7),
    rgb,
    light
  }
  const cfgJson = JSON.stringify(cfg).replace(/</g, '\\u003c')
  const logo = logoData(inp.logo)
  const els = [
    logo ? `<img id="logo" src="${logo}" alt="">` : '',
    inp.pill ? `<div id="pill" dir="auto">${esc(inp.pill)}</div>` : '',
    `<div id="head" dir="auto">${esc(inp.headline)}</div>`,
    inp.sub ? `<div id="sub" dir="auto">${esc(inp.sub)}</div>` : ''
  ].join('')
  const a = (x: number): string => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${x})`
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>scene</title>
<style>
html,body{margin:0;padding:0;width:1920px;height:1080px;overflow:hidden;background:${b0}}
#bg{position:absolute;left:0;top:0;width:1920px;height:1080px;background:linear-gradient(135deg,${b0},${b1})}
canvas{position:absolute;left:0;top:0;width:1920px;height:1080px}
#blur{position:absolute;left:210px;top:170px;width:1500px;height:740px;backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);-webkit-mask-image:radial-gradient(ellipse at center,#000 30%,rgba(0,0,0,0) 70%);mask-image:radial-gradient(ellipse at center,#000 30%,rgba(0,0,0,0) 70%)}
#scrim{position:absolute;left:150px;top:130px;width:1620px;height:820px;background:radial-gradient(ellipse at center,rgba(0,0,0,.58) 0%,rgba(0,0,0,.4) 38%,rgba(0,0,0,0) 72%)}
#blk{position:absolute;left:0;top:0;width:1920px;height:1080px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;font-family:'Segoe UI','Segoe UI Variable','Noto Sans','Helvetica Neue',Arial,'Segoe UI Historic','Segoe UI Symbol',Tahoma,sans-serif;color:#fff;text-shadow:0 2px 26px rgba(0,0,0,.5)}
#blk>*{will-change:transform,opacity}
#logo{max-width:380px;max-height:96px;object-fit:contain;margin-bottom:34px}
#pill{font-size:22px;font-weight:700;letter-spacing:.24em;text-transform:uppercase;padding:11px 28px 11px 32px;border-radius:999px;border:1.5px solid ${a(0.7)};background:${a(0.16)};color:${cssRgb(light)};margin-bottom:34px;text-shadow:none}
#head{font-weight:700;line-height:1.1;letter-spacing:-.01em;max-width:1500px;text-wrap:balance;overflow-wrap:break-word}
#sub{font-weight:400;line-height:1.3;color:rgba(255,255,255,.8);max-width:1300px;margin-top:30px;text-wrap:balance;overflow-wrap:break-word}
</style></head><body>
<div id="bg"></div><canvas id="c" width="1920" height="1080"></canvas>
<div id="blur"></div><div id="scrim"></div>
<div id="blk">${els}</div>
<script>
const CFG=${cfgJson};
${PAGE_JS}
</script></body></html>`
}

const PAGE_JS = String.raw`
(function(){
var W=1920,H=1080,T=CFG.t,KIND=CFG.kind,MOTIF=CFG.motif;
var cv=document.getElementById('c'),ctx=cv.getContext('2d');
function mulberry(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
var R=mulberry(CFG.seed*7919+13);
function rr(a,b){return a+(b-a)*R()}
function cl(x,a,b){a=a===undefined?0:a;b=b===undefined?1:b;return Math.min(b,Math.max(a,x))}
function eo(x){x=cl(x);return 1-Math.pow(1-x,3)}
function eio(x){x=cl(x);return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2}
function lp(a,b,t){return a+(b-a)*t}
function sg(t,a,b){return cl((t-a)/(b-a))}
var AR=CFG.rgb[0],AG=CFG.rgb[1],AB=CFG.rgb[2],LR=CFG.light[0],LG=CFG.light[1],LB=CFG.light[2];
function ac(a){return 'rgba('+AR+','+AG+','+AB+','+a+')'}
function lc(a){return 'rgba('+LR+','+LG+','+LB+','+a+')'}
function wh(a){return 'rgba(255,255,255,'+a+')'}

/* ---------- text layer ---------- */
var elLogo=document.getElementById('logo'),elPill=document.getElementById('pill'),elHead=document.getElementById('head'),elSub=document.getElementById('sub');
function fit(el,maxLines,from,to,step){
  if(!el)return;
  for(var s=from;s>=to;s-=step){
    el.style.fontSize=s+'px';
    var lh=parseFloat(getComputedStyle(el).lineHeight)||s*1.2;
    if(el.getBoundingClientRect().height<=lh*maxLines+2&&el.scrollWidth<=el.clientWidth+1)return;
  }
}
fit(elHead,2,108,38,2);
fit(elSub,2,38,24,1);
var LOGO={x:960,y:540};
(function(){var e=elLogo||elPill||elHead;if(e){LOGO={x:e.offsetLeft+e.offsetWidth/2,y:e.offsetTop+e.offsetHeight/2}}})();
var TK=Math.min(1,T/4);
var items=[[elLogo,.30],[elPill,.50],[elHead,.72],[elSub,1.02]];
function textAt(t){
  for(var i=0;i<items.length;i++){
    var e=items[i][0];if(!e)continue;
    var d=items[i][1]*TK,f=eo(sg(t,d,d+0.9*Math.max(.55,TK)));
    e.style.opacity=f;
    e.style.transform=f>=1?'none':'translateY('+((1-f)*34)+'px)';
    e.style.filter=f>=1?'none':'blur('+((1-f)*8)+'px)';
  }
  var s=document.getElementById('scrim'),b=document.getElementById('blur');
  var k=eo(sg(t,.2*TK,1.1*TK+.3));
  s.style.opacity=k;b.style.opacity=k;
}

/* ---------- sprites & primitives ---------- */
function mkGlow(size,col){
  var c=document.createElement('canvas');c.width=c.height=size;var g=c.getContext('2d');
  var gr=g.createRadialGradient(size/2,size/2,0,size/2,size/2,size/2);
  gr.addColorStop(0,'rgba(255,255,255,.95)');gr.addColorStop(.1,col(.9));gr.addColorStop(.3,col(.28));gr.addColorStop(.6,col(.07));gr.addColorStop(1,col(0));
  g.fillStyle=gr;g.fillRect(0,0,size,size);return c;
}
var GLOW=mkGlow(128,lc);
function dot(x,y,r,a){
  if(a<=.01)return;
  ctx.globalAlpha=a;
  ctx.globalCompositeOperation='lighter';
  ctx.drawImage(GLOW,x-r*5,y-r*5,r*10,r*10);
  ctx.globalCompositeOperation='source-over';
  ctx.fillStyle=lc(1);ctx.beginPath();ctx.arc(x,y,r,0,6.2832);ctx.fill();
  ctx.globalAlpha=1;
}
function rrect(x,y,w,h,r){
  w=Math.max(0,w);h=Math.max(0,h);r=Math.max(0,Math.min(r,w/2,h/2));ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();
}
function line(x1,y1,x2,y2,p,a,w,col){
  if(p<=0||a<=.01)return;
  var x=lp(x1,x2,p),y=lp(y1,y2,p);
  ctx.globalAlpha=a;
  ctx.globalCompositeOperation='lighter';ctx.strokeStyle=ac(.12);ctx.lineWidth=w*4;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x,y);ctx.stroke();
  ctx.globalCompositeOperation='source-over';ctx.strokeStyle=col||ac(.6);ctx.lineWidth=w;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x,y);ctx.stroke();
  ctx.globalAlpha=1;
}
function dashed(x1,y1,x2,y2,p,a){
  if(p<=0||a<=.01)return;
  ctx.globalAlpha=a;ctx.setLineDash([9,9]);ctx.strokeStyle=ac(.7);ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(lp(x1,x2,p),lp(y1,y2,p));ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
  dot(lp(x1,x2,p),lp(y1,y2,p),3,a*.9);
}

/* ---------- background ---------- */
function background(t){
  var u=t/T;
  var bx=960+Math.sin(t*.21)*420,by=540+Math.cos(t*.17)*240;
  var g=ctx.createRadialGradient(bx,by,0,bx,by,760);
  g.addColorStop(0,ac(.2));g.addColorStop(1,ac(0));
  ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
  var bx2=960-Math.sin(t*.16+1)*520,by2=540-Math.cos(t*.23)*300;
  var g2=ctx.createRadialGradient(bx2,by2,0,bx2,by2,520);
  g2.addColorStop(0,lc(.06));g2.addColorStop(1,lc(0));
  ctx.fillStyle=g2;ctx.fillRect(0,0,W,H);
  /* faint dot grid */
  ctx.fillStyle=wh(.045);
  for(var y=60;y<H;y+=60)for(var x=60;x<W;x+=60){ctx.fillRect(x-1,y-1,2,2)}
}

/* ---------- GRAPH ---------- */
var CX=960,CY=540;
var GN=[],GL=[];
(function(){
  var rx=700,ry=400,K=6;
  GN.push({x:CX,y:CY,r:15,k:0,par:-1});
  for(var k=0;k<K;k++){
    var a=-Math.PI/2+k*Math.PI*2/K+rr(-.07,.07);
    var tx=CX+Math.cos(a)*rx*rr(.94,1.04),ty=CY+Math.sin(a)*ry*rr(.94,1.04);
    var ti=GN.length;GN.push({x:tx,y:ty,r:10.5,k:1,par:0});GL.push([0,ti]);
    var n=4+Math.floor(R()*2),dirx=Math.cos(a),diry=Math.sin(a);
    for(var j=0;j<n;j++){
      var sp=(j-(n-1)/2)*.5+rr(-.1,.1),d=(j%2?rr(215,270):rr(130,185));
      var ca=Math.atan2(diry,dirx)+sp;
      var cx=cl(tx+Math.cos(ca)*d,90,W-90),cy=cl(ty+Math.sin(ca)*d*.8,80,H-80);
      var ci=GN.length;GN.push({x:cx,y:cy,r:rr(5,7),k:2,par:ti});GL.push([ti,ci]);
    }
  }
  var tops=[];for(var z=0;z<GN.length;z++)if(GN[z].k===1)tops.push(z);
  for(var k=0;k<tops.length;k++)GL.push([tops[k],tops[(k+1)%tops.length]]);
  for(var q=0;q<30&&GL.length<tops.length*6+12;q++){var i1=1+Math.floor(R()*(GN.length-1)),i2=1+Math.floor(R()*(GN.length-1));
    if(i1!==i2&&GN[i1].k===2&&GN[i2].k===2&&GN[i1].par!==GN[i2].par&&Math.hypot(GN[i1].x-GN[i2].x,GN[i1].y-GN[i2].y)<380)GL.push([i1,i2])}
  for(var i=0;i<GN.length;i++){var n=GN[i];n.ph=rr(0,6.28);n.ph2=rr(0,6.28);n.w=rr(.35,.7);n.am=n.k===0?4:rr(7,14);
    n.s=.3+R()*.5*T*.5;n.ox=rr(-1,1)*260;n.oy=rr(-1,1)*200;n.pulse=R()}
  for(var li=0;li<GL.length;li++){GL[li].pp=R();GL[li].pulse=R()<.4}
})();
function gpos(n,t,sway){
  var f=sway===undefined?1:sway;
  return [n.x+Math.sin(t*n.w+n.ph)*n.am*f,n.y+Math.cos(t*n.w*.8+n.ph2)*n.am*.8*f];
}
function graphResolved(t,mode){
  /* mode 'title' builds up, 'outro' is already built and fades in */
  var P=[],al=[];
  for(var i=0;i<GN.length;i++){
    var n=GN[i],st,d;
    if(mode==='title'){st=.3+n.s*(T-.3)*.5/(T*.5+1);st=.3+(n.k===0?0:.15+(i/GN.length)*.5)*T*.9*.7;d=Math.max(.7,.28*T)}
    else{st=.25+(i/GN.length)*.35*T;d=Math.max(.6,.25*T)}
    var a=eo(sg(t,st,st+d)),p=gpos(n,t);
    P.push([lp(p[0]+n.ox,p[0],a),lp(p[1]+n.oy,p[1],a)]);al.push(a);n.st=st;n.d=d;
  }
  var linkD=Math.max(.5,.2*T);
  for(var li=0;li<GL.length;li++){
    var L=GL[li],a=L[0],b=L[1];
    var s0=Math.max(GN[a].st+GN[a].d*.55,GN[b].st+GN[b].d*.4);
    var pr=eio(sg(t,s0,s0+linkD));
    var al2=Math.min(al[a],al[b]);
    line(P[a][0],P[a][1],P[b][0],P[b][1],pr,al2,1.6);
    if(L.pulse&&pr>=1){var pp=((t*.22+L.pp)%1);var px=lp(P[a][0],P[b][0],pp),py=lp(P[a][1],P[b][1],pp);dot(px,py,2.6,.85*al2*Math.sin(pp*3.14159))}
  }
  for(var i=0;i<GN.length;i++){
    var n=GN[i];
    dot(P[i][0],P[i][1],n.r*(.5+.5*al[i]),al[i]*(n.k===0?1:.95));
    if(n.k<2&&al[i]>.05){ctx.globalAlpha=al[i]*.5;ctx.strokeStyle=lc(.7);ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(P[i][0],P[i][1],n.r*2.1+(n.k===0?4:0),0,6.2832);ctx.stroke();ctx.globalAlpha=1}
  }
}
/* problem: scattered things */
var PD=[],PF=[],PFail=[];
(function(){
  var N=48;
  for(var i=0;i<N;i++){
    var h=GN[i%GN.length];
    PD.push({x:rr(80,W-80),y:rr(70,H-70),r:rr(2.8,5.6),w:rr(1.2,2.6),w2:rr(3.5,6),ph:rr(0,6.28),ph2:rr(0,6.28),dw:rr(.18,.45),da:rr(30,80),jx:rr(2,5),hx:h.x,hy:h.y,hv:i<GN.length,a:rr(.4,.8)});
  }
  for(var i=0;i<15;i++){
    var h=GN[(i*2+1)%GN.length];
    var lines=[];var nl=2+Math.floor(R()*3);for(var j=0;j<nl;j++)lines.push(rr(.4,.9));
    PF.push({x:rr(120,W-120),y:rr(100,H-100),w:rr(70,120),h:rr(90,140),rot:rr(-.6,.6),rw:rr(.3,.8),ph:rr(0,6.28),ph2:rr(0,6.28),dw:rr(.15,.4),da:rr(30,70),jx:rr(3,7),w2:rr(2.5,4.5),lines:lines,hx:h.x,hy:h.y,a:rr(.45,.85)});
  }
  for(var i=0;i<10;i++){var a=Math.floor(R()*N),b=Math.floor(R()*N);if(a===b)b=(a+7)%N;PFail.push({a:a,b:b,P:rr(2.3,3.6),ph:rr(0,4),f:rr(.35,.62)})}
})();
function dpos(d,t,pull){
  var x=d.x+Math.sin(t*d.dw+d.ph)*d.da+Math.sin(t*d.w2+d.ph)*d.jx;
  var y=d.y+Math.cos(t*d.dw*.9+d.ph2)*d.da*.7+Math.cos(t*d.w2*1.1+d.ph2)*d.jx;
  return [lp(x,d.hx,pull*.62),lp(y,d.hy,pull*.62)];
}
function graphProblem(t){
  var u=t/T,pull=eio(sg(u,.75,1)),fade=eo(sg(t,.2,1.0));
  var DP=[];
  for(var i=0;i<PD.length;i++){DP.push(dpos(PD[i],t,pull))}
  /* page-like fragments */
  for(var i=0;i<PF.length;i++){
    var f=PF[i],p=dpos(f,t,pull*.8);
    var rot=(f.rot+Math.sin(t*f.rw+f.ph)*.18+Math.sin(t*f.w2*1.3)*.015)*(1-pull*.7);
    ctx.save();ctx.translate(p[0],p[1]);ctx.rotate(rot);ctx.globalAlpha=f.a*fade*.8;
    rrect(-f.w/2,-f.h/2,f.w,f.h,8);ctx.fillStyle=ac(.07);ctx.fill();ctx.strokeStyle=ac(.5);ctx.lineWidth=1.6;ctx.stroke();
    ctx.fillStyle=wh(.5);ctx.fillRect(-f.w/2+12,-f.h/2+14,f.w*.35,5);
    for(var j=0;j<f.lines.length;j++){ctx.fillStyle=wh(.22);ctx.fillRect(-f.w/2+12,-f.h/2+34+j*16,(f.w-24)*f.lines[j],4)}
    ctx.restore();ctx.globalAlpha=1;
  }
  /* failed half-drawn links */
  for(var i=0;i<PFail.length;i++){
    var F=PFail[i],loc=((t+F.ph)%F.P)/F.P;
    var pr=eo(sg(loc,0,.22))*F.f,al=(1-sg(loc,.5,.78))*fade;
    var A=DP[F.a],B=DP[F.b];
    dashed(A[0],A[1],B[0],B[1],pr,al*.9);
  }
  /* hint of order at the end: faint, partial links between the homes */
  if(pull>0.02){
    for(var li=0;li<GL.length;li++){
      var a=DP[GL[li][0]],b=DP[GL[li][1]];
      line(a[0],a[1],b[0],b[1],.55*pull,pull*.55,1.4);
    }
  }
  for(var i=0;i<PD.length;i++){dot(DP[i][0],DP[i][1],PD[i].r,PD[i].a*fade)}
}

/* ---------- FLOW ---------- */
var FB=[],BW=200,BH=112;
(function(){
  for(var lane=0;lane<2;lane++){
    for(var i=0;i<5;i++){
      FB.push({lane:lane,i:i,x:260+i*350,y:lane?885:195,
        sx:0,sy:0,rot:rr(-.3,.3),jx:rr(4,8),ph:rr(0,6.28),ph2:rr(0,6.28),w:rr(1,2.4),dw:rr(.2,.45),da:rr(14,34)});
    }
  }
  for(var lane=0;lane<2;lane++){
    var perm=[0,1,2,3,4];for(var k=4;k>0;k--){var j=Math.floor(R()*(k+1));var tmp=perm[k];perm[k]=perm[j];perm[j]=tmp}
    for(var i=0;i<5;i++){var b=FB[lane*5+i];var slot=perm[i];
      b.sx=260+slot*350+rr(-70,70);b.sy=(lane?(H-480):(480-H+H))+0;
      b.sy=lane?rr(640,950):rr(130,440);}
  }
})();
function box(x,y,rot,lit,a,sc){
  if(a<=.01)return;
  ctx.save();ctx.translate(x,y);ctx.rotate(rot);ctx.scale(sc,sc);ctx.globalAlpha=a;
  if(lit>.02){ctx.globalCompositeOperation='lighter';var s=BW*1.9;ctx.globalAlpha=a*lit*.55;ctx.drawImage(GLOW,-s/2,-s*.42,s,s*.84);ctx.globalCompositeOperation='source-over';ctx.globalAlpha=a}
  rrect(-BW/2,-BH/2,BW,BH,18);
  ctx.fillStyle=lit>0?'rgba('+Math.round(lp(255,AR,lit))+','+Math.round(lp(255,AG,lit))+','+Math.round(lp(255,AB,lit))+','+lp(.05,.2,lit)+')':wh(.05);ctx.fill();
  ctx.strokeStyle=lit>0?lc(lp(.16,.95,lit)):wh(.16);ctx.lineWidth=lp(1.5,2.4,lit);ctx.stroke();
  ctx.fillStyle=lit>0?lc(lp(.3,1,lit)):wh(.3);ctx.beginPath();ctx.arc(-BW/2+30,-BH/2+30,10,0,6.2832);ctx.fill();
  ctx.fillStyle=wh(.5);rrect(-BW/2+52,-BH/2+24,80,12,6);ctx.fill();
  ctx.fillStyle=wh(.2);rrect(-BW/2+24,-BH/2+58,BW-48,9,4.5);ctx.fill();rrect(-BW/2+24,-BH/2+78,(BW-48)*.6,9,4.5);ctx.fill();
  ctx.restore();ctx.globalAlpha=1;
}
function arrow(x1,y1,x2,y2,pr,lit,a,gap,t,pulseOn){
  /* from box edge to box edge; gap>0 breaks the arrow in the middle */
  if(pr<=0||a<=.01)return;
  var col=lit>0?lc(lp(.35,.95,lit)):wh(.28);
  var dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy)||1,ux=dx/len,uy=dy/len;
  if(gap>0){
    var g0=.5-gap/2,g1=.5+gap/2;
    line(x1,y1,lp(x1,x2,g0),lp(y1,y2,g0),pr,a,2,col);
    line(lp(x1,x2,g1),lp(y1,y2,g1),x2,y2,pr*.0+Math.max(0,pr-.2),a,2,col);
    return;
  }
  line(x1,y1,x2,y2,pr,a,2.2,col);
  if(pr>.92){
    ctx.globalAlpha=a*sg(pr,.92,1);ctx.fillStyle=col;ctx.beginPath();ctx.moveTo(x2,y2);ctx.lineTo(x2-ux*16-uy*9,y2-uy*16+ux*9);ctx.lineTo(x2-ux*16+uy*9,y2-uy*16-ux*9);ctx.closePath();ctx.fill();ctx.globalAlpha=1;
  }
  if(pulseOn&&lit>.5){var pp=(t*.5+x1*.001)%1;dot(lp(x1,x2,pp),lp(y1,y2,pp),3,a*Math.sin(pp*3.14159)*.9)}
}
function flowResolved(t,mode){
  var cvg=mode==='outro'?eio(sg(t/T,0,1)):0;
  var B=[],al=[],lit=[];
  for(var k=0;k<FB.length;k++){
    var b=FB[k],ap,lt;
    if(mode==='title'){
      var as=.3+b.i*.07*T+b.lane*.04*T;ap=eo(sg(t,as,as+Math.max(.6,.22*T)));
      var ls=.28*T+b.i*.11*T+b.lane*.06*T;lt=eo(sg(t,ls,ls+Math.max(.4,.1*T)));
    }else{
      var as2=.25+b.i*.05*T+b.lane*.03*T;ap=eo(sg(t,as2,as2+Math.max(.5,.2*T)));
      var ls2=.2*T+b.i*.06*T+b.lane*.04*T;lt=.5+.5*eo(sg(t,ls2,ls2+.5));
    }
    var y=b.y+(b.lane?-1:1)*0; var sway=Math.sin(t*.5+b.ph)*5;
    B.push([b.x,y+sway,ap,lt]);al.push(ap);lit.push(lt);
  }
  for(var k=0;k<FB.length;k++){
    var b=FB[k];if(b.i>=4)continue;var n=k+1;
    var A=B[k],C=B[n];
    var pr=eio(sg(t,al[n]>0?(mode==='title'?(.3+(b.i+1)*.07*T+b.lane*.04*T):(.25+(b.i+1)*.05*T+b.lane*.03*T)):0,(mode==='title'?(.3+(b.i+1)*.07*T+b.lane*.04*T):(.25+(b.i+1)*.05*T+b.lane*.03*T))+.45));
    arrow(A[0]+BW/2+14,A[1],C[0]-BW/2-14,C[1],pr,lit[n],Math.min(al[k],al[n]),0,t,true);
  }
  for(var k=0;k<FB.length;k++){var A=B[k];box(A[0],A[1],0,lit[k],A[2],lp(.88,1,A[2]))}
}
function flowProblem(t){
  var u=t/T,pull=eio(sg(u,.75,1)),fade=eo(sg(t,.2,1.0));
  var B=[];
  for(var k=0;k<FB.length;k++){
    var b=FB[k];
    var hx=lp(b.sx,b.x,pull*.55),hy=lp(b.sy,b.y,pull*.55);
    var x=hx+Math.sin(t*b.dw+b.ph)*b.da+Math.sin(t*b.w+b.ph)*b.jx;
    var y=hy+Math.cos(t*b.dw*.9+b.ph2)*b.da*.7+Math.cos(t*b.w*1.1+b.ph2)*b.jx*.7;
    var rot=(b.rot+Math.sin(t*.6+b.ph)*.12)*(1-pull*.7);
    B.push([x,y,rot]);
  }
  /* arrows: intended order, but broken and pointing the wrong way */
  for(var k=0;k<FB.length;k++){
    var b=FB[k];if(b.i>=4)continue;
    var A=B[k],C=B[k+1];
    var gap=lp(.42,.16,pull);
    var dx=C[0]-A[0],dy=C[1]-A[1],len=Math.hypot(dx,dy)||1,ux=dx/len,uy=dy/len;
    var pr=fade;
    var wob=.5+.5*Math.sin(t*1.3+b.ph);
    arrow(A[0]+ux*BW*.55,A[1]+uy*BH*.55,C[0]-ux*BW*.55,C[1]-uy*BH*.55,pr,0,.7*fade,gap+(wob>.8?.06:0),t,false);
  }
  for(var k=0;k<FB.length;k++){box(B[k][0],B[k][1],B[k][2],0,.9*fade,1)}
}

/* ---------- CARDS ---------- */
var CARDS=[
  {x:90,y:90,w:470,h:300,t:'bars'},{x:90,y:420,w:470,h:200,t:'stat'},{x:90,y:650,w:470,h:340,t:'list'},
  {x:1360,y:90,w:470,h:240,t:'donut'},{x:1360,y:360,w:470,h:300,t:'line'},{x:1360,y:690,w:470,h:300,t:'bars'}
];
(function(){
  var types=['bars','stat','list','donut','line'];
  for(var i=0;i<CARDS.length;i++){var c=CARDS[i];c.ox=(c.x<900?-1:1)*rr(80,160);c.oy=rr(-60,60);c.vals=[];for(var j=0;j<8;j++)c.vals.push(rr(.25,.95));c.ph=rr(0,6.28);c.ph2=rr(0,6.28);c.wf=rr(1.5,3);c.dw=rr(.2,.4);c.da=rr(16,34);c.rot=rr(-.3,.3);c.rot2=rr(.15,.4);
    c.mx=rr(150,W-150);c.my=rr(130,H-130);c.mw=rr(260,430);c.mh=rr(170,280);c.mg=rr(.25,.75);c.jx=rr(2,5)}
  /* extra loose cards only used in the mess */
  for(var i=0;i<6;i++){CARDS.push({x:0,y:0,w:0,h:0,t:types[Math.floor(R()*5)],extra:true,vals:[rr(.25,.95),rr(.25,.95),rr(.25,.95),rr(.25,.95),rr(.25,.95),rr(.25,.95),rr(.25,.95),rr(.25,.95)],ph:rr(0,6.28),ph2:rr(0,6.28),wf:rr(1.5,3),dw:rr(.2,.4),da:rr(16,34),rot:rr(-.4,.4),rot2:rr(.15,.4),mx:rr(100,W-100),my:rr(100,H-100),mw:rr(240,400),mh:rr(150,260),mg:rr(.2,.7),jx:rr(2,5),ox:0,oy:0})}
})();
function cardBody(c,w,h,g,t){
  var pad=26;
  ctx.fillStyle=wh(.4);ctx.beginPath();ctx.arc(pad+7,pad+7,6,0,6.2832);ctx.fill();
  ctx.fillStyle=wh(.3);rrect(pad+24,pad+2,Math.min(110,w*.3),10,5);ctx.fill();
  var x0=pad,y0=pad+34,iw=w-pad*2,ih=h-pad*2-34;
  var v=c.vals;
  if(c.t==='bars'){
    var n=6,bw=iw/n*.58;
    for(var i=0;i<n;i++){
      var gg=eo(sg(g,i*.08,i*.08+.55)),hh=ih*v[i]*gg*(1+.03*Math.sin(t*1.1+i));
      var bx=x0+i*(iw/n)+(iw/n-bw)/2;
      rrect(bx,y0+ih-hh,bw,Math.max(2,hh),6);ctx.fillStyle=i===3||i===4?ac(.85):ac(.38);ctx.fill();
    }
    ctx.fillStyle=wh(.12);ctx.fillRect(x0,y0+ih+2,iw,2);
  }else if(c.t==='line'){
    var gp=eio(g);ctx.beginPath();var n=8;
    for(var i=0;i<n;i++){var px=x0+iw*i/(n-1),py=y0+ih*(1-v[i]*.85);if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py)}
    ctx.save();ctx.beginPath();ctx.rect(x0-4,y0-10,(iw+8)*gp,ih+30);ctx.clip();
    ctx.beginPath();for(var i=0;i<n;i++){var px=x0+iw*i/(n-1),py=y0+ih*(1-v[i]*.85);if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py)}
    ctx.lineTo(x0+iw,y0+ih);ctx.lineTo(x0,y0+ih);ctx.closePath();ctx.fillStyle=ac(.14);ctx.fill();
    ctx.beginPath();for(var i=0;i<n;i++){var px=x0+iw*i/(n-1),py=y0+ih*(1-v[i]*.85);if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py)}
    ctx.strokeStyle=lc(.95);ctx.lineWidth=3;ctx.lineJoin='round';ctx.stroke();ctx.restore();
  }else if(c.t==='donut'){
    var cx=x0+ih/2+10,cy=y0+ih/2,r=ih/2-6;
    ctx.lineWidth=16;ctx.strokeStyle=wh(.1);ctx.beginPath();ctx.arc(cx,cy,r,0,6.2832);ctx.stroke();
    ctx.strokeStyle=lc(.9);ctx.lineCap='round';ctx.beginPath();ctx.arc(cx,cy,r,-1.5708,-1.5708+6.2832*v[0]*.9*eio(g));ctx.stroke();ctx.lineCap='butt';
    for(var i=0;i<3;i++){ctx.fillStyle=wh(.25);rrect(cx+r+34,cy-34+i*30,(iw-ih-50)*(.9-i*.2),9,4.5);ctx.fill()}
  }else if(c.t==='stat'){
    var gg=eo(g);ctx.fillStyle=wh(.42*gg);rrect(x0,y0+4,iw*.42*gg,26,8);ctx.fill();
    ctx.fillStyle=wh(.22);rrect(x0,y0+48,iw*.62,10,5);ctx.fill();
    for(var i=0;i<14;i++){var hh=(10+v[i%8]*34)*gg;ctx.fillStyle=ac(.5);rrect(x0+iw*.5+i*(iw*.5/14),y0+4+(40-hh),iw*.5/14-5,hh,3);ctx.fill()}
  }else{
    for(var i=0;i<4;i++){
      var gg=eo(sg(g,i*.12,i*.12+.5)),yy=y0+i*(ih/4);ctx.globalAlpha*=1;
      var aa=gg;ctx.save();ctx.globalAlpha*=aa;
      ctx.fillStyle=i===1?lc(.9):wh(.3);ctx.beginPath();ctx.arc(x0+12,yy+14,9,0,6.2832);ctx.fill();
      ctx.fillStyle=wh(.34);rrect(x0+38,yy+6,(iw-130)*(.55+v[i]*.4),10,5);ctx.fill();
      ctx.fillStyle=wh(.16);rrect(x0+38,yy+24,(iw-130)*(.3+v[i]*.3),8,4);ctx.fill();
      rrect(x0+iw-58,yy+6,58,24,12);ctx.fillStyle=ac(.25);ctx.fill();
      ctx.restore();
    }
  }
}
function drawCard(c,x,y,w,h,rot,a,g,sc){
  if(a<=.01)return;
  ctx.save();ctx.translate(x+w/2,y+h/2);ctx.rotate(rot);ctx.scale(sc,sc);ctx.translate(-w/2,-h/2);
  ctx.globalAlpha=a;
  ctx.shadowColor='rgba(0,0,0,.35)';ctx.shadowBlur=30;ctx.shadowOffsetY=10;
  rrect(0,0,w,h,24);ctx.fillStyle='rgba(255,255,255,.065)';ctx.fill();
  ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.shadowOffsetY=0;
  ctx.strokeStyle=wh(.15);ctx.lineWidth=1.5;ctx.stroke();
  cardBody(c,w,h,g,NOW);
  ctx.restore();ctx.globalAlpha=1;
}
var NOW=0;
function cardsResolved(t,mode){
  for(var i=0;i<6;i++){
    var c=CARDS[i],as,d;
    if(mode==='title'){as=.3+i*.09*T;d=Math.max(.7,.25*T)}else{as=.25+i*.05*T;d=Math.max(.6,.2*T)}
    var a=eo(sg(t,as,as+d)),gs=as+d*.4,g=mode==='title'?sg(t,gs,gs+Math.max(.8,.3*T)):.25+.75*eo(sg(t,gs,gs+.8));
    var bob=Math.sin(t*.6+c.ph)*5;
    drawCard(c,lp(c.x+c.ox,c.x,a),lp(c.y+c.oy,c.y,a)+bob,c.w,c.h,0,a,g,lp(.94,1,a));
  }
}
function cardsProblem(t){
  var u=t/T,pull=eio(sg(u,.75,1)),fade=eo(sg(t,.2,1.0));
  for(var i=0;i<CARDS.length;i++){
    var c=CARDS[i];
    var bx=c.mx,by=c.my,bw=c.mw,bh=c.mh;
    var tx=c.extra?c.mx:c.x+c.w/2,ty=c.extra?c.my:c.y+c.h/2,tw=c.extra?c.mw:c.w,th=c.extra?c.mh:c.h;
    var k=pull*(c.extra?.0:.6);
    var cx=lp(bx,tx,k)+Math.sin(t*c.dw+c.ph)*c.da+Math.sin(t*c.wf+c.ph)*c.jx;
    var cy=lp(by,ty,k)+Math.cos(t*c.dw*.9+c.ph2)*c.da*.7+Math.cos(t*c.wf*1.1+c.ph2)*c.jx;
    var w=lp(bw,tw,k),h=lp(bh,th,k);
    var rot=(c.rot+Math.sin(t*c.rot2+c.ph)*.12)*(1-k*.8);
    drawCard(c,cx-w/2,cy-h/2,w,h,rot,fade*(c.extra?lp(.8,.35,pull):.9),lp(c.mg,.8,pull*.8),1);
  }
}

/* ---------- compose ---------- */
function frame(t){
  t=cl(t,0,T);
  NOW=t;
  ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
  ctx.clearRect(0,0,W,H);
  background(t);
  ctx.save();
  var u=t/T;
  if(KIND==='outro'){
    var e=eio(u),s=lp(1,.9,e);
    var cx=960+(LOGO.x-960)*e*.4,cy=540+(LOGO.y-540)*e*.5;
    ctx.translate(cx,cy);ctx.scale(s,s);ctx.translate(-960,-540);
    /* halo around the logo, in the picture's own space */
    var hl=sg(t,.3,1.4);
    var hx=960+(LOGO.x-960)/ (1) ,hy=LOGO.y;
    ctx.save();ctx.setTransform(1,0,0,1,0,0);
    var g=ctx.createRadialGradient(LOGO.x,LOGO.y,0,LOGO.x,LOGO.y,340);g.addColorStop(0,ac(.2*hl));g.addColorStop(1,ac(0));ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
    for(var r=0;r<2;r++){var ph=((t*.12+r*.5)%1);ctx.globalAlpha=(1-ph)*.18*hl;ctx.strokeStyle=lc(1);ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(LOGO.x,LOGO.y,70+ph*260,0,6.2832);ctx.stroke()}
    ctx.restore();ctx.globalAlpha=1;
  }
  var mode=KIND==='outro'?'outro':'title';
  if(KIND==='problem'){
    if(MOTIF==='graph')graphProblem(t);else if(MOTIF==='flow')flowProblem(t);else cardsProblem(t);
  }else{
    if(MOTIF==='graph')graphResolved(t,mode);else if(MOTIF==='flow')flowResolved(t,mode);else cardsResolved(t,mode);
  }
  ctx.restore();
  /* from a plain backdrop at the start: the whole motif eases in */
  textAt(t);
}
window.__seek=frame;
frame(0);
})();
`

export async function renderScene(inp: SceneInput, outFile: string): Promise<{ file: string; durationSec: number }> {
  const T = Math.max(0.5, inp.durationSec)
  const frames = Math.max(1, Math.round(T * FPS))
  mkdirSync(dirname(outFile), { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), 'vg-scene-'))
  let browser: Awaited<ReturnType<typeof launch>> | null = null
  try {
    browser = await launch({ width: 1920, height: 1080, scale: 1, userDataDir: join(tmp, 'profile') })
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 })
    await page.setContent(sceneHtml(inp), { waitUntil: 'load' })
    await page.evaluate('document.fonts && document.fonts.ready')

    const ff = spawn(
      ffmpegBin(),
      ['-hide_banner', '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-vcodec', 'mjpeg', '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '15', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    )
    let err = ''
    ff.stderr.on('data', (d) => (err += String(d)))
    const done = new Promise<void>((resolve, reject) => {
      ff.on('error', reject)
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.slice(-400)))))
    })
    done.catch(() => undefined)
    ff.stdin.on('error', () => undefined)
    try {
      for (let i = 0; i < frames; i++) {
        await page.evaluate(`window.__seek(${i / FPS})`)
        const buf = await page.screenshot({ type: 'jpeg', quality: 92, optimizeForSpeed: true })
        if (!ff.stdin.write(buf)) await new Promise<void>((r) => ff.stdin.once('drain', () => r()))
      }
    } finally {
      ff.stdin.end()
    }
    await done
    return { file: outFile, durationSec: frames / FPS }
  } finally {
    if (browser) await browser.close().catch(() => undefined)
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
}
