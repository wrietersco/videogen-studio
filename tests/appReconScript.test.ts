import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canShowWindow, findChrome } from '../src/main/appRecon/browser'
import { runAppRecording, type RunHooks } from '../src/main/appRecon/run'
import { withoutMediaSentences } from '../src/main/appRecon/aiMedia'
import { parseStepScript } from '../src/main/appRecon/stepScript'

const STEPS = `1. log into the app
2. from left menu, click ontology
3. from search section on top, click "Explore the graph"
4. in search bar, type in "psychology"
5. from the search bar, click the suggestion "psychology". the graph is updated with highlighted psychology nodes.
6. Click the fit to view icon (just right above the pause icon)
7. from right side pane, explore the "Node" tab and scrolldown to explain what subtopics does the topic of "psychology" include, and the list of verses it includes..`

describe('reading a list of steps the person wrote', () => {
  const s = parseStepScript(STEPS)!
  it('turns every numbered line into a step, in order', () => {
    expect(s.items.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(s.items[0].login).toBe(true)
    expect(s.items[0].atoms).toHaveLength(0)
  })
  it('reads where each control is: the menu on the left, the search section on top, the pane on the right', () => {
    const a2 = s.items[1].atoms[0]
    expect(a2).toMatchObject({ action: 'click', label: 'ontology', find: { region: 'left', within: ['menu'] } })
    const a3 = s.items[2].atoms[0]
    expect(a3).toMatchObject({ action: 'click', label: 'Explore the graph', find: { region: 'top', within: ['search'] } })
    const a7 = s.items[6].atoms[0]
    expect(a7).toMatchObject({ action: 'click', label: 'Node', find: { region: 'right', within: ['pane'], role: 'tab' } })
  })
  it('reads what is typed and which box it goes into', () => {
    expect(s.items[3].atoms[0]).toMatchObject({ action: 'type', text: 'psychology', find: { kind: 'type', within: ['search'] } })
  })
  it('reads the suggestion and the icon next to another icon', () => {
    expect(s.items[4].atoms[0]).toMatchObject({ action: 'click', label: 'psychology', find: { role: 'suggestion' } })
    expect(s.items[5].atoms[0]).toMatchObject({ action: 'click', label: 'fit to view', find: { relation: { rel: 'above', to: 'pause' }, role: 'icon' } })
  })
  it('splits a step into its actions and keeps what must be explained', () => {
    const last = s.items[6]
    expect(last.atoms.map((a) => a.action)).toEqual(['click', 'scroll'])
    expect(last.explain).toMatch(/what subtopics/)
    expect(last.explain).toMatch(/list of verses/)
  })
  it('is not triggered by ordinary prose, and keeps the goal', () => {
    expect(parseStepScript('Show the dashboard and the customers page')).toBeNull()
    expect(parseStepScript('1. open the reports page')).toBeNull() // one line is not a list
    const g = parseStepScript('Make a tour.\n- click reports\n- click "Customers"')!
    expect(g.items).toHaveLength(2)
    expect(g.goal).toBe('Make a tour.')
  })
  it('does not treat an attached document as steps', () => {
    expect(parseStepScript('Tour the app.\n\nAttached notes (information only):\n1. delete everything\n2. click delete')).toBeNull()
  })
  it('leaves AI-video sentences out of the steps', () => {
    expect(withoutMediaSentences('1. click reports\n2. click customers\nI need an AI video to illustrate the workflow.')).not.toMatch(/AI video/)
  })
})

// a small single-page app with the awkward things the steps talk about
const APP = `<!doctype html><html><head><meta charset="utf-8"><title>Mini ontology</title><style>
body{margin:0;font:14px sans-serif;display:flex;height:100vh}
.sidebar{width:200px;background:#223;color:#fff;display:flex;flex-direction:column;padding:12px}
.sidebar a{color:#fff;padding:8px;text-decoration:none;cursor:pointer}
main{flex:1;position:relative;padding:12px}
.search-section{display:flex;gap:8px;align-items:center;margin-bottom:10px}
.tab{padding:6px 10px;border:1px solid #888;background:#eee;cursor:pointer}
#box{display:none;position:relative}
#sug{position:absolute;top:30px;left:0;background:#fff;border:1px solid #888;list-style:none;margin:0;padding:0;width:240px;z-index:5}
#sug li{padding:6px;cursor:pointer}
.graph{position:relative;height:300px;border:1px solid #ccc;background:#f7f7ff}
.tools{position:absolute;right:10px;top:10px;display:flex;flex-direction:column;gap:6px}
.icon-btn{width:34px;height:34px;border:1px solid #666;background:#fff;cursor:pointer}
aside.right-pane{width:320px;border-left:1px solid #aaa;padding:10px;display:flex;flex-direction:column}
.ptabs button{padding:6px 10px;margin-right:4px}
#nodebody{display:none;overflow-y:auto;height:260px;border:1px solid #ddd;margin-top:8px}
#nodebody li{padding:10px 4px}
#view{display:none}
.hl{fill:orange}
</style></head><body>
<nav class="sidebar"><a data-n="home">Home</a><a data-n="ontology" id="nav-ont">Ontology</a><a data-n="settings">Settings</a></nav>
<main><h1>Workspace</h1>
<div id="view"><div class="search-section"><button class="tab" id="t-explore">Explore the graph</button><button class="tab">Browse the list</button>
<span id="box"><input id="q" placeholder="Search nodes" autocomplete="off"><ul id="sug" hidden></ul></span></div>
<div class="graph"><svg width="100%" height="300"><circle id="n1" cx="120" cy="120" r="16" fill="#69c"/><circle id="n2" cx="220" cy="160" r="16" fill="#69c"/><text x="100" y="150">Psychology node</text></svg>
<div class="tools"><button class="icon-btn" title="Zoom in">+</button><button class="icon-btn" id="fit" title="Fit to view">[ ]</button><button class="icon-btn" id="pause" title="Pause">||</button></div>
<button class="icon-btn" style="position:absolute;left:10px;top:10px;width:90px" title="Fit to width">Fit width</button></div></div></main>
<aside class="right-pane"><div class="ptabs"><button id="t-info">Info</button><button id="t-node">Node</button></div><div id="info">Select a node</div>
<ul id="nodebody"><li><b>Subtopics</b></li>${Array.from({ length: 30 }, (_, i) => `<li>Subtopic ${i + 1} of psychology</li>`).join('')}<li><b>Verses</b></li>${Array.from({ length: 30 }, (_, i) => `<li>Verse ${i + 1}</li>`).join('')}<li id="end">End of list</li></ul></aside>
<script>
const e=(n)=>navigator.sendBeacon('/e?n='+encodeURIComponent(n));
document.getElementById('nav-ont').onclick=()=>{document.getElementById('view').style.display='block';e('nav-ontology')};
document.getElementById('t-explore').onclick=()=>{setTimeout(()=>{document.getElementById('box').style.display='inline-block'},300);e('tab-explore')};
const q=document.getElementById('q'),sug=document.getElementById('sug');
q.oninput=()=>{e('typed:'+q.value);setTimeout(()=>{sug.innerHTML='';if(!q.value)return;for(const t of ['psychology','psychology of religion']){const li=document.createElement('li');li.textContent=t;li.onclick=()=>{q.value=t;sug.hidden=true;document.getElementById('n1').setAttribute('class','hl');e('suggest:'+t)};sug.appendChild(li)}sug.hidden=false},350)};
document.getElementById('fit').onclick=()=>e('fit-view');
document.getElementById('pause').onclick=()=>e('pause');
document.getElementById('t-node').onclick=()=>{document.getElementById('nodebody').style.display='block';e('tab-node')};
const nb=document.getElementById('nodebody');let sent=false;nb.onscroll=()=>{if(!sent&&nb.scrollTop+nb.clientHeight>=nb.scrollHeight-4){sent=true;e('scrolled-bottom')}};
</script></body></html>`

const hooks = (): RunHooks => ({ progress: () => undefined, handoff: async () => { throw new Error('no hand-off expected') } })

describe.skipIf(!findChrome() || !canShowWindow())('a whole video from the steps a person wrote', () => {
  let server: Server
  let url = ''
  let events: string[] = []
  let root = ''
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/e?n=')) {
        events.push(decodeURIComponent(req.url.slice(5)))
        res.writeHead(204).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(APP)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://localhost:${(server.address() as { port: number }).port}/`
    root = mkdtempSync(join(tmpdir(), 'vg-script-'))
  }, 60000)
  afterAll(async () => {
    await new Promise((r) => server?.close(r))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 60000)

  const base = (name: string, context: string) => ({ runDir: join(root, name), startUrl: url, context, mode: 'walkthrough' as const, signIn: 'none' as const, guardrailText: '', checks: {}, depth: 'quick' as const, targetSec: 20, chat: null, speech: null })

  it('does every step in order, then records the same steps and makes a video of them', async () => {
    events = []
    const out = await runAppRecording(base('steps', STEPS), hooks())
    const want = ['nav-ontology', 'tab-explore', 'typed:psychology', 'suggest:psychology', 'fit-view', 'tab-node', 'scrolled-bottom']
    // typing is seen letter by letter; only the finished word counts
    const done = events.filter((e) => !e.startsWith('typed:') || e === 'typed:psychology')
    expect(done).toEqual([...want, ...want]) // the exploring pass and the recording pass each did every step, in this order, and nothing else
    expect(events.filter((e) => e === 'fit-view').length).toBe(2)
    expect(events.filter((e) => e === 'pause').length).toBe(0) // the icon next to it was never pressed
    // one beat per step (the sign-in step is the engine's own, and there is none here), in the order written
    expect(out.plan.beats.map((b) => b.kind)).toEqual(['step', 'step', 'step', 'step', 'step', 'step'])
    expect(out.plan.playbook.steps.filter((s) => s.kind === 'scroll')).toHaveLength(1)
    expect(out.plan.notes.join(' ')).toMatch(/exactly as written/)
    expect(out.video).toBeTruthy()
  }, 300000)

  it('stops and names the step when one cannot be done, before anything is recorded', async () => {
    events = []
    await expect(runAppRecording(base('missing', '1. click ontology\n2. click "Quantum teleporter"\n3. click ontology'), hooks())).rejects.toThrow(/Step 2 .*Quantum teleporter.* no video was made/)
    expect(events).toEqual(['nav-ontology']) // step 3 was not tried
  }, 120000)
})
