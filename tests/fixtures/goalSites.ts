import { createServer, type Server } from 'node:http'

/**
 * Three small apps for the goal planner's tests: a long dashboard whose target section is far down the page, a shop with prices
 * and several identical "Add to cart" buttons, and a task board with one overdue task. Each page tells the test what happened by
 * posting to /e?n=<name>, and shows it in a readout, the way a real app shows the result of a click.
 */

const BASE = `<meta charset="utf-8"><style>
body{font:15px system-ui;margin:0;color:#222} header{display:flex;gap:16px;align-items:center;padding:12px 24px;background:#f3f4f6}
section{padding:24px;border-bottom:1px solid #ddd} button{font:inherit;padding:6px 12px;margin:2px;cursor:pointer} .tall{min-height:520px}
ul{list-style:none;padding:0} li{padding:8px;border:1px solid #e5e7eb;margin:6px 0} footer{padding:24px;background:#f3f4f6}
</style><script>const e=(n)=>fetch('/e?n='+encodeURIComponent(n)).catch(()=>{})</script>`

const DASH = `<!doctype html><title>Energy atlas</title>${BASE}
<header><h1>Energy atlas</h1><a href="#top">Overview</a><button id="dark" onclick="e('dark-mode')">Dark mode</button></header>
<section class="tall"><h2>Monthly consumption trend</h2>
 <div role="tablist"><button role="tab" onclick="e('tab:residential');document.getElementById('trend').textContent='Residential peaks in July at 412 GWh'">Residential</button><button role="tab" onclick="e('tab:commercial');document.getElementById('trend').textContent='Commercial peaks in August at 288 GWh'">Commercial</button></div>
 <p id="trend">Pick a sector.</p></section>
<section class="tall"><h2>Notes on the data</h2><p>Figures are metered monthly and rounded to the nearest gigawatt hour.</p></section>
<section class="tall"><h2>Methodology</h2><p>Each region reports to the national grid operator.</p></section>
<section class="tall"><h2>Sources</h2><p>National statistics office, 2024 release.</p></section>
<section id="regional"><h2>Regional distribution</h2><p id="sel">Selected: none</p>
 <ul>
  <li><button onclick="pick('East',52)">East</button> <span>52 TWh</span></li>
  <li><button onclick="pick('North',31)">North</button> <span>31 TWh</span></li>
  <li><button onclick="pick('West',24)">West</button> <span>24 TWh</span></li>
  <li><button onclick="pick('South',17)">South</button> <span>17 TWh</span></li>
 </ul>
 <button onclick="step(-1)">Prev</button><button onclick="step(1)">Next ▶</button> <span id="k">Region 1 of 4</span></section>
<footer><a href="/terms">Terms</a> <button onclick="e('delete-data');document.getElementById('sel').textContent='All data deleted'">Delete data</button></footer>
<script>
let i=0;const R=['East','North','West','South'];
function pick(n,v){e('pick:'+n);document.getElementById('sel').textContent='Selected: '+n+' — '+v+' TWh'}
function step(d){i=(i+d+4)%4;e('step:'+R[i]);document.getElementById('k').textContent='Region '+(i+1)+' of 4';document.getElementById('sel').textContent='Selected: '+R[i]}
</script>`

const SHOP = `<!doctype html><title>Brightside shop</title>${BASE}
<header><h1>Brightside</h1><a href="#cart" onclick="e('open-cart')">Cart (<span id="count">0</span>)</a></header>
<aside style="padding:16px;float:left;width:220px"><h2>Filters</h2>
 <label>Category <select id="cat" onchange="e('cat:'+this.value)"><option>All</option><option>Shoes</option><option>Socks</option><option>Bags</option></select></label><br>
 <label>Max price <input id="max" placeholder="Max price" oninput="e('max:'+this.value)"></label><br>
 <button onclick="filt()">Apply filters</button></aside>
<main style="margin-left:240px"><section><h2>Products</h2><p id="msg">Showing all products.</p>
 <ul id="list">
  <li data-cat="Shoes" data-p="55"><a href="#p1" onclick="e('view:Daily Canvas Sneakers');return false">Daily Canvas Sneakers</a> <b>£55</b> <button onclick="add('Daily Canvas Sneakers')">Add to cart</button></li>
  <li data-cat="Socks" data-p="18"><a href="#p2" onclick="e('view:Merino Trail Socks');return false">Merino Trail Socks</a> <b>£18</b> <button onclick="add('Merino Trail Socks')">Add to cart</button></li>
  <li data-cat="Bags" data-p="45"><a href="#p3" onclick="e('view:Mini Crossbody');return false">Mini Crossbody</a> <b>£45</b> <button onclick="add('Mini Crossbody')">Add to cart</button></li>
  <li data-cat="Shoes" data-p="129"><a href="#p4" onclick="e('view:Trail Shell Jacket');return false">Trail Shell Jacket</a> <b>£129</b> <button onclick="add('Trail Shell Jacket')">Add to cart</button></li>
 </ul></section></main>
<script>
let n=0;
function filt(){const c=document.getElementById('cat').value,m=parseFloat(document.getElementById('max').value)||1e9;let k=0;
 for(const li of document.querySelectorAll('#list li')){const ok=(c==='All'||li.dataset.cat===c)&&Number(li.dataset.p)<=m;li.style.display=ok?'':'none';if(ok)k++}
 e('filter:'+c+':'+m);document.getElementById('msg').textContent='Showing '+k+' products.'}
function add(name){n++;e('add:'+name);document.getElementById('count').textContent=n;document.getElementById('msg').textContent='Added to cart: '+name}
</script>`

const TASKS = `<!doctype html><title>Sprintly</title>${BASE}
<header><h1>Sprintly</h1><button onclick="e('settings')">Settings</button></header>
<section><h2>Sprint board</h2>
 <div><button onclick="show('all')">All</button><button onclick="show('overdue')">Overdue</button><button onclick="show('done')">Done</button></div>
 <p id="count">Showing all 4 tasks.</p>
 <ul id="tasks">
  <li data-s="open"><button onclick="open_('Write release notes','due in 3 days')">Write release notes</button> <small>due in 3 days</small></li>
  <li data-s="overdue"><button onclick="open_('Fix login redirect','overdue by 14 days')">Fix login redirect</button> <small>due 12 Nov</small> <mark>Overdue</mark></li>
  <li data-s="done"><button onclick="open_('Update logo','finished yesterday')">Update logo</button> <small>done</small></li>
  <li data-s="open"><button onclick="open_('Add dark theme','due in 9 days')">Add dark theme</button> <small>due in 9 days</small></li>
 </ul>
 <div id="detail" style="border:1px solid #bbb;padding:12px;margin-top:12px">Pick a task to see its details.</div></section>
<script>
function show(f){e('filter:'+f);let k=0;for(const li of document.querySelectorAll('#tasks li')){const ok=f==='all'||li.dataset.s===f;li.style.display=ok?'':'none';if(ok)k++}
 document.getElementById('count').textContent='Showing '+k+' task'+(k===1?'':'s')+'.'}
function open_(t,s){e('open:'+t);document.getElementById('detail').innerHTML='<b>'+t+'</b> — '+s+(s.startsWith('overdue')?' <button onclick="e(\\'reschedule\\');this.parentNode.append(\\' Moved to tomorrow.\\')">Reschedule</button>':'')}
</script>`

export interface GoalSites {
  url: string
  events: string[]
  close(): Promise<void>
}

export async function startGoalSites(): Promise<GoalSites> {
  const events: string[] = []
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/e?n=')) {
      events.push(decodeURIComponent(req.url.slice(5)))
      res.writeHead(204).end()
      return
    }
    const page = req.url?.startsWith('/shop') ? SHOP : req.url?.startsWith('/tasks') ? TASKS : DASH
    res.writeHead(200, { 'content-type': 'text/html' }).end(page)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://localhost:${(server.address() as { port: number }).port}`
  return { url, events, close: () => new Promise((r) => server.close(() => r())) }
}
