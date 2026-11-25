import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Small pages that each hold one trap for the action layer: an overlay that arrives mid-run, a cookie banner, a button in an
 * iframe and one in a shadow root, a kanban board (drag by pointer events, and by the browser's own drag-and-drop), sliders,
 * date pickers, an infinite feed, colour swatches and icon-only buttons, a table with totals, product cards with prices, a
 * contenteditable and a code editor, and an SVG chart. Everything a page does is reported to /e so a test can see it.
 */

const head = (title: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
body{margin:0;font:15px sans-serif;background:#fafafa;color:#222}.wrap{padding:16px;max-width:900px;margin:0 auto}
button{font:inherit;padding:8px 12px;margin:4px;border:1px solid #888;border-radius:8px;background:#fff;cursor:pointer}
.card{border:1px solid #ccc;border-radius:10px;padding:10px;margin:8px 0;background:#fff}
#out{min-height:22px;color:#145;font-weight:600;margin:8px 0}
</style></head><body>`
const ev = `const ev=(n)=>fetch('/e?n='+encodeURIComponent(n)).catch(()=>{});`

export const PAGES: Record<string, string> = {
  // ------------------------------------------------------------ an overlay that arrives mid-run, and a cookie banner
  '/overlay': `${head('Overlay')}<div class="wrap"><h1>Shop</h1>
<button id="order" onclick="ev('order');document.getElementById('out').textContent='Order placed'">Place order</button>
<button id="save" onclick="ev('save');document.getElementById('out').textContent='Saved'">Save settings</button>
<div id="out"></div>
<p style="height:900px">filler</p></div>
<div id="cookie" role="dialog" aria-label="Cookie consent" style="position:fixed;left:0;right:0;bottom:0;background:#222;color:#fff;padding:14px;z-index:50;display:none"><span>We use cookies to improve your experience.</span>
 <button id="ck-accept" onclick="ev('cookie-accept');this.parentElement.remove()">Accept all</button>
 <button id="ck-reject" onclick="ev('cookie-essential');this.parentElement.remove()">Only necessary</button></div>
<div id="promo" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100;display:none;align-items:center;justify-content:center"><div class="card" role="dialog" aria-modal="true" style="width:340px;position:relative"><button aria-label="Close" onclick="ev('promo-close');document.getElementById('promo').remove()" style="position:absolute;right:4px;top:4px">×</button><h3>10% off today!</h3><p>Join our newsletter</p><input placeholder="Your email" id="promo-email"><button onclick="ev('promo-subscribe')">Subscribe</button><br><button onclick="ev('promo-close');document.getElementById('promo').remove()">No thanks</button></div></div>
<script>${ev}
setTimeout(()=>document.getElementById('cookie').style.display='block',200);
setTimeout(()=>document.getElementById('promo').style.display='flex',1200);
</script></body></html>`,

  // ------------------------------------------------------------ iframe + shadow root
  '/frames': `${head('Frames')}<div class="wrap"><h1>Docs</h1>
<iframe id="fr" style="width:420px;height:120px;border:1px solid #888" srcdoc="<button id='fb' onclick=&quot;parent.fetch('/e?n=frame-button')&quot;>Frame button</button><p>inside a frame</p>"></iframe>
<div id="host"></div><div id="out"></div></div>
<script>${ev}
const sr=document.getElementById('host').attachShadow({mode:'open'});sr.innerHTML='<button id="sb">Shadow button</button>';
sr.getElementById('sb').addEventListener('click',()=>{ev('shadow-button');document.getElementById('out').textContent='shadow pressed'});
</script></body></html>`,

  // ------------------------------------------------------------ kanban: pointer drag
  '/kanban': `${head('Board')}<style>.board{display:flex;gap:14px}.col{flex:1;background:#eef;border-radius:10px;padding:8px;min-height:220px}.col h3{margin:4px}.task{background:#fff;border:1px solid #99a;border-radius:8px;padding:10px;margin:8px 0;cursor:grab;user-select:none}.dragging{opacity:.5}</style>
<div class="wrap"><h1>Sprint</h1><div class="board" id="board">
<div class="col" data-col="todo"><h3>To do</h3><div class="task">Fix login redirect</div><div class="task">Write docs</div></div>
<div class="col" data-col="doing"><h3>In progress</h3><div class="task">Logo refresh</div></div>
<div class="col" data-col="done"><h3>Done</h3><div class="task">Set up CI</div></div></div><div id="out"></div></div>
<script>${ev}
let drag=null,startX=0,startY=0,moved=false;
document.addEventListener('mousedown',e=>{const t=e.target.closest('.task');if(!t)return;drag=t;startX=e.clientX;startY=e.clientY;moved=false});
document.addEventListener('mousemove',e=>{if(!drag)return;if(Math.abs(e.clientX-startX)+Math.abs(e.clientY-startY)>5){moved=true;drag.classList.add('dragging')}});
document.addEventListener('mouseup',e=>{if(!drag)return;const t=drag;drag=null;t.classList.remove('dragging');if(!moved)return;
 const el=document.elementFromPoint(e.clientX,e.clientY);const col=el&&el.closest('.col');if(!col)return;
 const over=el.closest('.task');
 if(over&&over!==t){const r=over.getBoundingClientRect();if(e.clientY<r.top+r.height/2)over.before(t);else over.after(t)}else col.appendChild(t);
 document.getElementById('out').textContent=t.textContent+' → '+col.dataset.col;ev('moved:'+t.textContent+'>'+col.dataset.col)});
</script></body></html>`,

  // ------------------------------------------------------------ kanban: native HTML5 drag and drop only
  '/kanban5': `${head('Board 5')}<style>.board{display:flex;gap:14px}.col{flex:1;background:#eef;border-radius:10px;padding:8px;min-height:220px}.task{background:#fff;border:1px solid #99a;border-radius:8px;padding:10px;margin:8px 0;cursor:grab}</style>
<div class="wrap"><div class="board">
<div class="col" data-col="todo"><h3>To do</h3><div class="task" draggable="true">Fix login redirect</div></div>
<div class="col" data-col="done"><h3>Done</h3><div class="task" draggable="true">Set up CI</div></div></div><div id="out"></div></div>
<script>${ev}
let cur=null;
document.addEventListener('dragstart',e=>{cur=e.target.closest('.task');if(e.dataTransfer)e.dataTransfer.setData('text/plain','x')});
document.addEventListener('dragover',e=>{e.preventDefault()});
document.addEventListener('drop',e=>{e.preventDefault();const c=e.target.closest&&e.target.closest('.col');if(!cur||!c)return;const over=e.target.closest('.task');if(over&&over!==cur)over.before(cur);else c.appendChild(cur);ev('dropped:'+cur.textContent+'>'+c.dataset.col)});
</script></body></html>`,

  // ------------------------------------------------------------ sliders
  '/slider': `${head('Sliders')}<div class="wrap"><label for="vol">Volume</label> <input type="range" id="vol" min="0" max="100" step="1" value="10" style="width:300px"><span id="volv">10</span>
<div style="margin-top:30px"><div>Price range <span id="pv">£20 – £120</span></div>
<div id="dual" style="position:relative;width:300px;height:30px;margin-top:12px"><div style="position:absolute;left:0;right:0;top:13px;height:4px;background:#ccc"></div>
<input type="range" id="lo" aria-label="Minimum price" min="0" max="200" step="5" value="20" style="position:absolute;left:0;width:300px;pointer-events:none;-webkit-appearance:none;background:transparent" class="dualthumb">
<input type="range" id="hi" aria-label="Maximum price" min="0" max="200" step="5" value="120" style="position:absolute;left:0;width:300px;pointer-events:none;-webkit-appearance:none;background:transparent" class="dualthumb"></div></div>
<style>.dualthumb::-webkit-slider-thumb{-webkit-appearance:none;pointer-events:all;width:16px;height:16px;border-radius:50%;background:#357;cursor:pointer}</style></div>
<script>${ev}
const q=id=>document.getElementById(id);
q('vol').oninput=()=>{q('volv').textContent=q('vol').value;ev('vol:'+q('vol').value)};
const pv=()=>{q('pv').textContent='£'+q('lo').value+' – £'+q('hi').value;ev('price:'+q('lo').value+'-'+q('hi').value)};q('lo').oninput=pv;q('hi').oninput=pv;
</script></body></html>`,

  // ------------------------------------------------------------ dates: native and a calendar
  '/dates': `${head('Dates')}<div class="wrap"><label>Check-in <input type="date" id="native"></label>
<div style="margin-top:20px"><label>Appointment <input type="text" id="appt" readonly placeholder="Pick a date" style="width:160px"></label>
<div id="cal" role="dialog" aria-label="Calendar" style="display:none;border:1px solid #888;background:#fff;width:260px;padding:8px;margin-top:4px"></div></div><div id="out"></div></div>
<script>${ev}
const M=['January','February','March','April','May','June','July','August','September','October','November','December'];
let y=2026,m=10;const cal=document.getElementById('cal'),inp=document.getElementById('appt');
function draw(){const first=new Date(y,m,1).getDay(),n=new Date(y,m+1,0).getDate();let h='<div style="display:flex;justify-content:space-between"><button aria-label="Previous month" id="pm">‹</button><strong>'+M[m]+' '+y+'</strong><button aria-label="Next month" id="nm">›</button></div><div role="grid" style="display:grid;grid-template-columns:repeat(7,1fr)">';
 for(let i=0;i<first;i++)h+='<span class="outside"></span>';
 for(let d=1;d<=n;d++)h+='<button role="gridcell" aria-label="'+M[m]+' '+d+', '+y+'" data-d="'+d+'" style="padding:4px;margin:1px">'+d+'</button>';
 cal.innerHTML=h+'</div>';
 cal.querySelector('#pm').onclick=()=>{m--;if(m<0){m=11;y--}draw()};cal.querySelector('#nm').onclick=()=>{m++;if(m>11){m=0;y++}draw()};
 cal.querySelectorAll('[data-d]').forEach(b=>b.onclick=()=>{inp.value=M[m]+' '+b.dataset.d+', '+y;cal.style.display='none';ev('date:'+inp.value)})}
inp.onclick=()=>{draw();cal.style.display='block'};
document.getElementById('native').onchange=e=>ev('native:'+e.target.value);
</script></body></html>`,

  // ------------------------------------------------------------ an infinite feed
  '/feed': `${head('Feed')}<div class="wrap"><h1>News</h1><div id="feed"></div><div id="end" style="height:20px"></div></div>
<script>let n=0;const feed=document.getElementById('feed');
function more(){for(let i=0;i<12;i++){n++;const d=document.createElement('div');d.className='card';d.textContent=n===40?'Release notes for version 2.0':'Post number '+n;feed.appendChild(d)}}
more();const io=new IntersectionObserver(es=>{if(es[0].isIntersecting&&n<120)setTimeout(more,200)});io.observe(document.getElementById('end'));</script></body></html>`,

  // ------------------------------------------------------------ swatches, icon buttons, a table, product cards
  '/shop': `${head('Shop')}<style>.sw{display:inline-block;width:28px;height:28px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px #999;margin:4px;cursor:pointer}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}.prod{display:inline-block;width:200px;vertical-align:top}.price{font-weight:700}.price del{color:#999;font-weight:400}.ico{width:34px;height:34px;padding:4px}</style>
<div class="wrap"><h1>Jackets</h1>
<div id="swatches"><span class="sw" style="background:#d33" data-n="red"></span><span class="sw" style="background:#2a6fd6" data-n="blue"></span><span class="sw" style="background:#2a9d3a" data-n="green"></span></div>
<div><button class="ico" aria-label="Settings" onclick="ev('gear')"><svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="none" stroke="#333" stroke-width="3"/></svg></button>
<button class="ico" aria-label="Add to wishlist" onclick="ev('heart')"><svg width="22" height="22" viewBox="0 0 24 24"><path d="M12 21C5 15 3 11 3 8a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 3-2 7-9 13z" fill="#c22"/></svg></button>
<button class="ico" title="Delete" onclick="ev('bin')"><svg width="22" height="22" viewBox="0 0 24 24"><rect x="6" y="7" width="12" height="14" fill="#555"/></svg></button></div>
<div id="products"><div class="card prod"><h4>Trail Shell Jacket</h4><div class="price"><del>£159</del> £129</div><button onclick="ev('buy:trail')">View</button></div>
<div class="card prod"><h4>City Rain Jacket</h4><div class="price">£99</div><button onclick="ev('buy:city')">View</button></div>
<div class="card prod"><h4>Summit Parka Jacket</h4><div class="price">£1,249.00</div><button onclick="ev('buy:summit')">View</button></div>
<div class="card prod"><h4>Wool Scarf</h4><div class="price">£19</div><button onclick="ev('buy:scarf')">View</button></div></div>
<h2>Orders</h2><table id="orders"><thead><tr><th>Customer</th><th>Items</th><th>Total</th></tr></thead><tbody>
<tr onclick="ev('row:Ana')"><td>Ana</td><td>2</td><td>£120.50</td></tr><tr onclick="ev('row:Bo')"><td>Bo</td><td>5</td><td>£1,240.00</td></tr><tr onclick="ev('row:Cy')"><td>Cy</td><td>1</td><td>£89.99</td></tr></tbody></table>
<p>Pick a size: <button onclick="ev('men')">Men's cut</button> <button onclick="ev('women')">Women's cut</button> <button onclick="ev('kids')">Kids' cut</button></p>
<p>Stylist: <span class="card" style="display:inline-block;margin:4px" onclick="ev('stylist:Daniel')">Daniel</span><span class="card" style="display:inline-block;margin:4px" onclick="ev('stylist:Mei')">Mei</span></p></div>
<script>${ev}document.querySelectorAll('.sw').forEach(s=>s.onclick=()=>ev('swatch:'+s.dataset.n));</script></body></html>`,

  // ------------------------------------------------------------ editors
  '/editor': `${head('Editor')}<div class="wrap"><h3>Title</h3><div id="title" contenteditable="true" style="border:1px solid #888;padding:6px;min-height:24px">Old title</div>
<h3>Body</h3><div id="code" class="cm-content" contenteditable="true" spellcheck="false" style="border:1px solid #888;padding:8px;min-height:90px;font-family:monospace;white-space:pre-wrap">{"plan": "pro"}</div>
<div style="margin-top:12px"><span id="task" ondblclick="this.contentEditable='true';this.focus()" style="border-bottom:1px dotted #888">Rename me</span></div>
<h3>Subscribe</h3><input id="mail" type="email" placeholder="Your email"><input id="q" type="text" placeholder="Search"><div id="out"></div></div>
<script>document.getElementById('code').addEventListener('keydown',e=>{if(e.key==='{'){e.preventDefault();document.execCommand('insertText',false,'{}');const s=getSelection();s.modify('move','backward','character')}});</script></body></html>`,

  // ------------------------------------------------------------ keyboard
  '/keys': `${head('Keys')}<div class="wrap"><button id="a">Alpha</button><button id="b">Beta</button><button id="c">Export</button><button id="d">Delta</button>
<div id="palette" style="display:none;border:1px solid #333;padding:10px;background:#fff;width:300px;margin-top:10px"><input id="pi" placeholder="Type a command"></div><div id="out"></div></div>
<script>${ev}
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();document.getElementById('palette').style.display='block';document.getElementById('pi').focus();ev('palette')}
 if(e.key==='Escape'){document.getElementById('palette').style.display='none'}});</script></body></html>`,

  // ------------------------------------------------------------ svg chart
  '/chart': `${head('Chart')}<div class="wrap"><h2>Monthly consumption</h2>
<svg id="ch" width="420" height="240" viewBox="0 0 420 240"><g><line x1="40" y1="40" x2="400" y2="40" stroke="#ddd"/><line x1="40" y1="80" x2="400" y2="80" stroke="#ddd"/><line x1="40" y1="120" x2="400" y2="120" stroke="#ddd"/><line x1="40" y1="160" x2="400" y2="160" stroke="#ddd"/><line x1="40" y1="200" x2="400" y2="200" stroke="#999"/>
<text x="30" y="40" font-size="10" text-anchor="end">400</text><text x="30" y="120" font-size="10" text-anchor="end">200</text><text x="30" y="200" font-size="10" text-anchor="end">0</text>
<rect class="bar" x="50" y="140" width="40" height="60" fill="#2a6fd6"/><rect class="bar" x="110" y="80" width="40" height="120" fill="#2a6fd6"/><rect class="bar" x="170" y="40" width="40" height="160" fill="#2a6fd6"/><rect class="bar" x="230" y="100" width="40" height="100" fill="#2a6fd6"/><rect class="bar" x="290" y="120" width="40" height="80" fill="#2a6fd6"/>
<text x="70" y="216" font-size="11" text-anchor="middle">Apr</text><text x="130" y="216" font-size="11" text-anchor="middle">May</text><text x="190" y="216" font-size="11" text-anchor="middle">Jun</text><text x="250" y="216" font-size="11" text-anchor="middle">Jul</text><text x="310" y="216" font-size="11" text-anchor="middle">Aug</text></g></svg>
<div id="readout" style="min-height:22px;font-weight:600"></div></div>
<script>${ev}
document.querySelectorAll('.bar').forEach((b,i)=>b.addEventListener('click',()=>{document.getElementById('readout').textContent='Selected: '+['Apr','May','Jun','Jul','Aug'][i];ev('bar:'+i)}));</script></body></html>`
}

export interface ExecSite {
  url: string
  events: string[]
  close(): Promise<void>
}

export async function startExecSite(): Promise<ExecSite> {
  const events: string[] = []
  const server: Server = createServer((req, res) => {
    const u = req.url ?? '/'
    if (u.startsWith('/e?n=')) {
      events.push(decodeURIComponent(u.slice(5)))
      res.writeHead(204).end()
      return
    }
    const page = PAGES[u.split('?')[0]]
    if (!page) { res.writeHead(404).end('not found'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return { url: `http://localhost:${port}`, events, close: () => new Promise<void>((r) => server.close(() => r())) }
}
