import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A page shaped like the research page that showed the bug: a long page, a heading a long way down ("Whole-Quran even–odd
 * circle", with an en dash), a chart drawn on a CANVAS (nothing in the markup to point at) with blue, green and orange lines
 * that show a tooltip on hover and do something when clicked, "◀ match" / "match ▶" buttons, and a detail panel with tabs
 * that a phone keeps folded away behind a button. Everything the pointer does is reported to /e so a test can see it.
 */

export const PRESET = 'ٱلرَّحْمَٰن ↔ ٱلرَّحِيم · the Merciful ↔ the Mercy-Giving'

const filler = (n: number, topic: string): string => Array.from({ length: n }, (_, i) => `<p>${topic} — paragraph ${i + 1}. Counting rules are stated by the engine and every occurrence is measured with them.</p>`).join('')

export const CHART_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Compare</title><style>
body{margin:0;font:15px sans-serif;background:#fcfcfa;color:#222}
.wrap{padding:16px;max-width:900px;margin:0 auto}
h1{font-size:24px}h3{font-size:20px;margin:24px 0 8px}
button{font:inherit;padding:8px 12px;margin:3px;border:1px solid #888;border-radius:8px;background:#fff;cursor:pointer}
.card{border:1px solid #ccc;border-radius:12px;padding:12px;margin:16px 0;background:#fff}
#results{display:none}
canvas{display:block;width:100%;max-width:338px;height:300px;border:1px solid #ddd;background:#fff;touch-action:none}
.tip{position:absolute;pointer-events:none;background:#222;color:#fff;padding:6px 8px;border-radius:6px;font-size:13px;display:none;z-index:9;max-width:220px}
#readout,#where,#word-detail{min-height:22px;margin:6px 0;color:#145;font-weight:600}
#panel-toggle{display:inline-block}
#detail-pane{display:none;border:1px solid #bbb;border-radius:10px;padding:10px;margin-top:10px}
#detail-pane.open{display:block}
.rd-tabs button.on{background:#dfe9ff;border-color:#468}
.tabpanel{display:none;padding:8px 0}.tabpanel.on{display:block}
.word{display:inline-block;margin:4px;padding:2px 8px;font-size:24px;border-bottom:2px dotted #468;cursor:pointer}
@media (min-width:700px){#panel-toggle{display:none}#detail-pane{display:block}}
</style></head><body><div class="wrap">
<h1>Compare two words or phrases</h1>
<p>See how often each appears, where in the Quran, and whether they show up together.</p>
<div>Not sure? Try: <button id="preset">${PRESET}</button></div>
<div id="results">
<h3>Per-surah occurrences</h3>
<div class="card"><svg width="300" height="150" viewBox="0 0 300 150"><rect x="20" y="60" width="30" height="80" fill="#1f77b4"/><rect x="70" y="30" width="30" height="110" fill="#1f77b4"/><rect x="120" y="90" width="30" height="50" fill="#1f77b4"/></svg>${filler(6, 'Per-surah')}</div>
<h3>Corpus timeline</h3>
<div class="card"><svg width="300" height="100" viewBox="0 0 300 100"><circle cx="40" cy="50" r="6" fill="#e8601c"/><circle cx="120" cy="40" r="6" fill="#e8601c"/><circle cx="200" cy="60" r="6" fill="#e8601c"/></svg>${filler(10, 'Timeline')}</div>
${filler(14, 'Letters per occurrence')}
<h3>Whole-Quran even–odd circle</h3>
<div class="card" id="circle-card">
 <p>6,236 rings, one per verse · matches highlighted</p>
 <div style="position:relative;width:338px;max-width:100%"><canvas id="circle" width="338" height="300"></canvas><div class="tip" id="tip"></div></div>
 <div id="readout">Nothing selected</div>
 <div><button id="prev">◀ match</button><button id="next">match ▶</button></div><div id="where">At match 0 of 91</div>
 <button id="panel-toggle" aria-controls="detail-pane" aria-expanded="false">Show details</button>
 <div id="detail-pane" class="rd-pane"><div class="rd-tabs" role="tablist"><button role="tab" id="tab-about" class="on">About the words</button><button role="tab" id="tab-verse">Verse</button><button role="tab" id="tab-matches">Matches 91</button></div>
  <div class="tabpanel on" id="p-about"><p>Phrase 1 · root ر ح م</p><p id="verse-line" class="verse"><span class="word" id="w1">ٱلرَّحْمَٰن</span><span class="word" id="w2">ٱلرَّحِيم</span></p><div id="word-detail">Click a word of the verse for its details</div></div>
  <div class="tabpanel" id="p-verse"><p>Verse 27:30 — it is from Solomon, and it is: In the name of God, the Merciful, the Mercy-Giving.</p></div>
  <div class="tabpanel" id="p-matches"><p>91 matches across the Quran. First: 1:1, then 1:3, then 2:163.</p></div>
 </div>
</div>
${filler(8, 'Gaps between occurrences')}
</div></div>
<script>
const ev=(n)=>navigator.sendBeacon('/e?n='+encodeURIComponent(n));
document.getElementById('preset').onclick=()=>{document.getElementById('results').style.display='block';ev('preset')};
// the chart: three lines on a canvas, in the colours a person calls blue, green and orange
const cv=document.getElementById('circle'),cx=cv.getContext('2d'),tip=document.getElementById('tip');
const LINES=[{n:'blue',c:'#1f6fd0',a:[20,250],b:[310,60],say:'Blue line: 27 verses where both words occur'},{n:'green',c:'#2a9d3a',a:[20,110],b:[310,230],say:'Green line: 34 verses with the second word only'},{n:'orange',c:'#f08a1a',a:[20,40],b:[310,280],say:'Orange line: 56 verses with the first word only'}];
let picked='';
function draw(){cx.clearRect(0,0,338,300);for(const l of LINES){cx.strokeStyle=l.c;cx.lineWidth=l.n===picked?7:4;cx.beginPath();cx.moveTo(...l.a);cx.lineTo(...l.b);cx.stroke()}}
draw();
function dist(l,x,y){const[ax,ay]=l.a,[bx,by]=l.b;const t=Math.max(0,Math.min(1,((x-ax)*(bx-ax)+(y-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2)));return Math.hypot(x-(ax+t*(bx-ax)),y-(ay+t*(by-ay)))}
function hit(e){const r=cv.getBoundingClientRect(),x=(e.clientX-r.left)*338/r.width,y=(e.clientY-r.top)*300/r.height;return{x,y,l:LINES.filter(l=>dist(l,x,y)<9).sort((p,q)=>dist(p,x,y)-dist(q,x,y))[0]}}
cv.addEventListener('mousemove',(e)=>{const h=hit(e);if(h.l){tip.textContent=h.l.say;tip.style.display='block';tip.style.left=(e.clientX-cv.getBoundingClientRect().left+12)+'px';tip.style.top=(e.clientY-cv.getBoundingClientRect().top+12)+'px';cv.style.cursor='pointer'}else{tip.style.display='none';cv.style.cursor='default'}});
cv.addEventListener('mouseleave',()=>{tip.style.display='none'});
cv.addEventListener('click',(e)=>{const h=hit(e);if(!h.l)return;picked=h.l.n;draw();document.getElementById('readout').textContent='Selected: '+h.l.say;ev('line:'+h.l.n)});
let m=0;document.getElementById('prev').onclick=()=>{m=Math.max(0,m-1);document.getElementById('where').textContent='At match '+m+' of 91';ev('prev')};
document.getElementById('next').onclick=()=>{m=Math.min(91,m+1);document.getElementById('where').textContent='At match '+m+' of 91';ev('next')};
document.getElementById('panel-toggle').onclick=(e)=>{const p=document.getElementById('detail-pane');p.classList.toggle('open');e.target.setAttribute('aria-expanded',p.classList.contains('open'));ev('panel-toggle')};
for(const [t,p,name] of [['tab-about','p-about','About the words'],['tab-verse','p-verse','Verse'],['tab-matches','p-matches','Matches']]){document.getElementById(t).onclick=()=>{for(const [a,b] of [['tab-about','p-about'],['tab-verse','p-verse'],['tab-matches','p-matches']]){document.getElementById(a).classList.toggle('on',a===t);document.getElementById(b).classList.toggle('on',b===p)}ev('tab:'+name)}}
for(const w of document.querySelectorAll('.word'))w.onclick=()=>{document.getElementById('word-detail').textContent='Root ر ح م · "'+(w.id==='w1'?'the Merciful':'the Mercy-Giving')+'" · appears '+(w.id==='w1'?56:34)+' times';ev('word:'+w.id)};
</script></body></html>`

export interface ChartSite {
  url: string
  events: string[]
  close(): Promise<void>
}

export async function startChartSite(): Promise<ChartSite> {
  const events: string[] = []
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/e?n=')) {
      events.push(decodeURIComponent(req.url.slice(5)))
      res.writeHead(204).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CHART_PAGE)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return { url: `http://localhost:${port}/`, events, close: () => new Promise<void>((r) => server.close(() => r())) }
}
