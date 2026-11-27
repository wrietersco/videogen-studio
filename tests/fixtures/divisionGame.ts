import { createServer, type Server } from 'node:http'

/**
 * A small kids' division game for the goal planner's tests, built like the real ones: an intro with a "▶ Let's Play!" button, a drawn
 * (SVG) ruler, a toolbar of buttons with an icon and a word (📏 Size, ✂️ Cut), a zoom bar named by symbols (＋ － 🔬 Max), a number
 * pad whose keys are digits and symbols (⌫ ✓ ✕) that opens over the page, and a confirm bar (✔ ✘) before a cut. The result of a
 * cut is a line on screen ("12 ÷ 3 = 4 cm each") and a card in the math book. Each press tells the test what happened (/e?n=...).
 */

const PAGE = `<!doctype html><meta charset="utf-8"><title>Division Playland</title>
<style>
body{font:16px system-ui;margin:0;background:#fff7e6;color:#222}
#intro{position:fixed;inset:0;background:#fff7e6;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:5}
#intro.hide{display:none}
button{font:inherit;padding:10px 16px;margin:4px;border-radius:12px;border:2px solid #aaa;background:#fff;cursor:pointer}
#bar{display:flex;gap:6px;padding:12px}
#stage{padding:10px 24px}
svg{width:100%;height:150px;background:#fff;border:1px solid #ddd}
#zoom{position:fixed;right:14px;top:70px;display:flex;flex-direction:column}
#modal{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:4}
#modal[hidden],#confirm[hidden]{display:none}
.sheet{background:#fff;padding:18px;border-radius:16px;width:280px}
#pad{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}
#confirm{position:fixed;left:50%;top:300px;transform:translateX(-50%);background:#fff;border:2px solid #6c6;padding:8px 14px;border-radius:14px;z-index:3}
#result{font-size:20px;font-weight:600;margin:8px 24px;min-height:28px}
#book{margin:0 24px;padding:0;list-style:none}#book li{background:#fff;border:1px solid #cde;margin:4px 0;padding:6px 10px;border-radius:8px}
</style>
<script>const e=(n)=>fetch('/e?n='+encodeURIComponent(n)).catch(()=>{})</script>
<div id="intro"><h1>Math Games</h1><div>✂️ Division Playland</div><button id="start" onclick="start()">▶ Let's Play!</button><p>Cut rulers into equal pieces</p></div>
<div id="bar">
 <button id="tSize" title="Scale Setter" onclick="openPad('size')">📏 Size</button>
 <button id="tCut" title="Partition Maker" onclick="openPad('cut')">✂️ Cut</button>
 <button id="tReset" onclick="reset()">🔄 Reset</button>
</div>
<div id="zoom"><button title="Zoom in" onclick="zoom(2)">＋</button><button title="Zoom out" onclick="zoom(0.5)">－</button><button onclick="zoomMax()">🔬 Max</button></div>
<div id="stage"><svg id="svg" viewBox="0 0 1000 150"><g id="ruler"></g></svg><div id="hint">Tap ✂️ to split equally</div></div>
<div id="result"></div><ul id="book"></ul>
<div id="confirm" hidden><span id="ctext"></span><button id="yes" title="Yes, cut it!" onclick="doCut()">✔</button><button id="no" title="No, go back" onclick="cancelCut()">✘</button></div>
<div id="modal" hidden><div class="sheet"><button onclick="closePad()">✕</button><h2 id="mtitle">How long?</h2><div id="mval">—</div><div id="pad"></div></div></div>
<script>
let L=100, k=1, pieces=1, mode='', val='', pend=0
const $=(s)=>document.querySelector(s)
function fmt(x){return String(parseFloat((Math.round(x*100)/100).toFixed(2)))}
function draw(){
  const g=$('#ruler');g.innerHTML='';const w=Math.min(960*k,960*Math.max(1,k)),per=w/pieces
  for(let i=0;i<pieces;i++){const r=document.createElementNS('http://www.w3.org/2000/svg','rect');r.setAttribute('x',20+i*per);r.setAttribute('y',40);r.setAttribute('width',per-2);r.setAttribute('height',60);r.setAttribute('fill',['#6fd6a8','#6fb9f2','#ff8fa3','#b492f5'][i%4]);g.appendChild(r)}
  $('#hint').textContent='Ruler: '+fmt(L)+' cm'+(pieces>1?' in '+pieces+' pieces':'')+' · zoom ×'+k
}
function start(){$('#intro').classList.add('hide');e('start');draw()}
function reset(){L=100;pieces=1;k=1;$('#result').textContent='';draw();e('reset')}
function zoom(f){k=Math.max(1,Math.min(16,k*f));e('zoom:'+k);draw();$('#result').textContent='Zoom ×'+k+(k>=4?' — the millimetres show':'')}
function zoomMax(){k=16;e('zoom:max');draw();$('#result').textContent='Zoomed all the way in! 🔬 each tiny line is 1 mm'}
function openPad(m){mode=m;val='';$('#mtitle').textContent=m==='size'?'How long should this ruler be?':'Cut into how many parts?';$('#mval').textContent='—';$('#modal').hidden=false}
function closePad(){$('#modal').hidden=true}
const pad=$('#pad');['1','2','3','4','5','6','7','8','9','⌫','0','.','✓'].forEach((c)=>{const b=document.createElement('button');b.textContent=c;b.onclick=()=>key(c);pad.appendChild(b)})
function key(c){
  if(c==='⌫'){val=val.slice(0,-1)}else if(c==='✓'){return submit()}else if(c!=='.'||!val.includes('.')){val+=c}
  $('#mval').textContent=val||'—'
}
function submit(){
  const v=parseFloat(val);if(!(v>0)){$('#hint').textContent='Type a number first';return}
  if(mode==='size'){if(v<1||v>100){$('#hint').textContent='Pick 1 to 100';return}L=v;pieces=1;k=1;closePad();e('size:'+v);$('#result').textContent='';draw()}
  else{if(v<2||v>12){$('#hint').textContent='Pick 2 to 12 parts';return}pend=v;closePad();$('#ctext').textContent='Cut into '+fmt(v)+' parts?';$('#confirm').hidden=false;e('cutpreview:'+v)}
}
function cancelCut(){$('#confirm').hidden=true}
function doCut(){
  $('#confirm').hidden=true;pieces=Math.ceil(pend);const q=Math.floor(L/pend*100)/100;e('cut:'+L+'/'+pend)
  $('#result').textContent=fmt(L)+' ÷ '+fmt(pend)+' = '+fmt(q)+' cm each';draw()
  const li=document.createElement('li');li.textContent='📓 '+fmt(L)+' ÷ '+fmt(pend)+' = '+fmt(q);$('#book').appendChild(li)
}
</script>`

export interface DivisionGame {
  url: string
  events: string[]
  close(): Promise<void>
}

export async function startDivisionGame(): Promise<DivisionGame> {
  const events: string[] = []
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/e?n=')) {
      events.push(decodeURIComponent(req.url.slice(5)))
      res.writeHead(204).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://localhost:${(server.address() as { port: number }).port}/division.html`, events, close: () => new Promise((r) => server.close(() => r())) }
}
