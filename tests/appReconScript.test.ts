import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canShowWindow, findChrome } from '../src/main/appRecon/browser'
import { runAppRecording, sameAddress, type RunHooks } from '../src/main/appRecon/run'
import { withoutMediaSentences } from '../src/main/appRecon/aiMedia'
import { parseStepScript } from '../src/main/appRecon/stepScript'
import { matchOption } from '../src/main/appRecon/pick'
import { scriptFromList } from '../src/main/appRecon/agent/brief'
import { describeNetFailure } from '../src/main/appRecon/explore'
import type { Segment } from '../src/shared/agentBrief'

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

const MIZAN = `log into the app and then follow the steps to follow for screen recording:
1. open: https://taaweel.snapkodex.com/numerical_analysis/explore.html#circle
2. from the left panel ensure to click SHAPES -> 05 \`The even-odd circle\` option
3. in your own words tell that with the help of mathematics we distributed even verse number ayas on top of the circle and odd at bottom.
4. then provide a conclusion statement and add CTA`

describe('a step that names an address and a menu path', () => {
  const s = parseStepScript(MIZAN)!
  it('opens the whole address, #fragment included, and nothing else from that step', () => {
    expect(s.items[0].atoms).toEqual([{ action: 'open', label: 'Open page', url: 'https://taaweel.snapkodex.com/numerical_analysis/explore.html#circle' }])
    expect(s.items[0].notes).toEqual([])
  })
  it('clicks the last stop of a menu path, quoted in backticks, on the left even after "ensure to"', () => {
    expect(s.items[1].atoms).toHaveLength(1)
    expect(s.items[1].atoms[0]).toMatchObject({ action: 'click', label: 'The even-odd circle', find: { region: 'left', within: ['pane'] } })
  })
  it('also reads "go to <address>", a bare address and an unquoted menu path', () => {
    const t = parseStepScript('1. go to https://example.com/app?x=1#tab.\n2. click Settings -> Billing')!
    expect(t.items[0].atoms).toEqual([{ action: 'open', label: 'Open page', url: 'https://example.com/app?x=1#tab' }])
    expect(t.items[1].atoms[0]).toMatchObject({ action: 'click', label: 'Billing' })
  })
  it('reads "from the left menu click ontology" with no comma', () => {
    const t = parseStepScript('1. from the left menu click ontology\n2. click reports')!
    expect(t.items[0].atoms[0]).toMatchObject({ action: 'click', label: 'ontology', find: { region: 'left', within: ['menu'] } })
  })
  it('takes the list in "Changes to make" instead of running the first list again', () => {
    const t = parseStepScript(`${MIZAN}\n\nChanges to make to the earlier video of this app (they win wherever they differ from the above):\n1. click reports\n2. click customers`)!
    expect(t.items.map((i) => i.said)).toEqual(['click reports', 'click customers'])
  })
})

const MIZAN_PICKS = `1. open: https://taaweel.snapkodex.com/numerical_analysis/explore.html#circle
2. in your own words tell that with the help of mathematics we distributed even verse number ayas on top of the circle and odd at bottom. you can switch to any surah and visualize it to see the balance. for example, then step 3 comes go to the \`Text to Study\` dropdown in header of the page on top left and select Surah An-Nur, and show the even-odd-structure. then switch to surah Ya-Sin, then show its even odd structure
3. then provide a conclusion statement and add CTA`

describe('choosing entries in a dropdown', () => {
  const s = parseStepScript(MIZAN_PICKS)!
  it('reads the dropdown and every entry named, even in the middle of an explanation', () => {
    const picks = s.items[1].atoms.filter((a) => a.action === 'select')
    expect(picks).toHaveLength(2)
    expect(picks[0]).toMatchObject({ action: 'select', option: 'An-Nur', label: 'Text to Study', find: { kind: 'select', target: 'Text to Study', region: 'left', within: ['header'] } })
    expect(picks[1]).toMatchObject({ action: 'select', option: 'Ya-Sin', label: 'Text to Study' })
    expect(s.items[1].explain).toMatch(/mathematics/)
    // "switch to any surah" names no entry, and nothing in the item is clicked
    expect(s.items[1].atoms.map((a) => a.action)).toEqual(['select', 'select'])
  })
  it('reads a plain step too, and leaves "select" alone when no dropdown is meant', () => {
    const t = parseStepScript('1. select Ya-Sin from the surah dropdown\n2. select the Reports tab')!
    expect(t.items[0].atoms).toEqual([{ action: 'select', label: 'surah', option: 'Ya-Sin', find: { target: 'surah', kind: 'select' } }])
    expect(t.items[1].atoms[0]).toMatchObject({ action: 'click', label: 'Reports' })
  })
  const list = ['1 · Al-Fatihah (7 v · Meccan)', '2 · Al-Baqarah (286 v · Medinan)', '24 · An-Nur (64 v · Medinan)', '36 · Ya-Sin (83 v · Meccan)', '114 · An-Nas (6 v · Meccan)']
  it('finds the entry by its name, whatever the number and brackets around it say', () => {
    expect(matchOption(list, 'An-Nur')).toBe(2)
    expect(matchOption(list, 'Surah An-Nur')).toBe(2)
    expect(matchOption(list, 'ya sin')).toBe(3)
    expect(matchOption(list, '24')).toBe(2)
    expect(matchOption(list, 'Nas')).toBe(4)
    expect(matchOption(list, 'Quantum teleporter')).toBe(-1)
  })
})

describe('a list of steps the reader split into pages', () => {
  const BRIEF = `# overall structure
start intro with a question, do you know you can visualize quran by its own mathematical balance?
# recorded steps to show:
log into the app and then follow the steps to follow for screen recording:
${MIZAN_PICKS}
--
simple outro cover with brand logo and CTA.`
  const url = 'https://taaweel.snapkodex.com/numerical_analysis/explore.html#circle'
  const page = (id: string): Segment => ({ id, kind: 'page', said: `open: ${url}`, required: true, url, how: 'steps', emphasis: 'normal' })
  it('is filmed as one exact script again, where the first page stood, and the narration follows it', () => {
    const segs: Segment[] = [
      { id: 's1', kind: 'ai-clip', said: 'question', required: true, subject: 'q', purpose: 'intro', style: null },
      page('s2'),
      { id: 's3', kind: 'narration', said: 'n', required: true, claims: ['a'], over: { segment: 's2' } },
      page('s4'),
      { id: 's5', kind: 'narration', said: 'n2', required: true, claims: ['b'], over: { segment: 's4' } },
      { id: 's6', kind: 'card', said: 'outro', required: true, card: 'outro' }
    ]
    scriptFromList(segs, BRIEF.replace('3. then provide', '4. then provide'))
    expect(segs.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's5', 's6'])
    const script = segs[1] as Extract<Segment, { kind: 'page' }>
    expect(script).toMatchObject({ kind: 'page', how: 'script', url })
    expect(script.actions?.length).toBeGreaterThan(1)
    expect((segs[2] as Extract<Segment, { kind: 'narration' }>).over).toEqual({ segment: 's2' })
    expect((segs[3] as Extract<Segment, { kind: 'narration' }>).over).toEqual({ segment: 's2' })
  })
  it('leaves a plan alone that already has the script, and pages that are not in the list', () => {
    const have: Segment[] = [{ ...page('s1'), how: 'script' }, page('s2')]
    scriptFromList(have, BRIEF)
    expect(have).toHaveLength(2)
    const other: Segment[] = [{ id: 's1', kind: 'page', said: 'show the pricing page', required: true, url: 'https://x.test/pricing', how: 'tour', emphasis: 'normal' }]
    scriptFromList(other, BRIEF)
    expect(other).toHaveLength(1)
    expect((other[0] as Extract<Segment, { kind: 'page' }>).how).toBe('tour')
  })
})

describe('a connection that drops while opening the app', () => {
  it('is said in plain words, not as a browser error code', () => {
    const msg = describeNetFailure('net::ERR_NAME_NOT_RESOLVED at https://taaweel.snapkodex.com/numerical_analysis/explore.html#circle', 'https://taaweel.snapkodex.com/x')!
    expect(msg).toMatch(/^taaweel\.snapkodex\.com could not be reached: this computer could not look up its address/)
    expect(msg).not.toMatch(/net::/)
    expect(describeNetFailure('net::ERR_INTERNET_DISCONNECTED at https://a.test/', 'https://a.test/')).toMatch(/internet connection dropped/)
    expect(describeNetFailure('Navigation timeout of 20000 ms exceeded', 'https://a.test/')).toBeNull()
  })
})

describe('the address the person gave', () => {
  it('counts its #fragment: a sign-in redirect drops it, so the page is opened again', () => {
    expect(sameAddress('https://a.test/x/explore.html', 'https://a.test/x/explore.html#circle')).toBe(false)
    expect(sameAddress('https://a.test/x/explore.html#circle', 'https://a.test/x/explore.html#circle')).toBe(true)
    expect(sameAddress('https://a.test/x/explore.html#circle', 'https://a.test/x/explore.html')).toBe(true)
    expect(sameAddress('https://a.test/x/?next=1', 'https://a.test/x')).toBe(true)
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

// a page like the one the dropdown steps are about: a left menu (with an en dash in a name), a header dropdown, a view picked by #fragment
const STUDY = `<!doctype html><html><head><meta charset="utf-8"><title>Perspectives</title><style>
body{margin:0;font:14px sans-serif}header{display:flex;gap:8px;align-items:center;padding:10px;border-bottom:1px solid #ccc}
.side{position:absolute;left:0;top:50px;width:240px}.side a{display:block;padding:8px;cursor:pointer}.side b{display:block;padding:8px;color:#888}
main{margin-left:260px;padding:20px}
</style></head><body>
<header><span>TEXT TO STUDY</span><button>&lsaquo;</button><select id="s"><option value="0">The whole Quran</option><option value="1">1 · Al-Fatihah (7 v · Meccan)</option><option value="24">24 · An-Nur (64 v · Medinan)</option><option value="36">36 · Ya-Sin (83 v · Meccan)</option></select><button>&rsaquo;</button></header>
<nav class="side"><b>BEGIN HERE</b><a id="m-map">00 Map of the Quran</a><b>SHAPES</b><a id="m-score">04 Shape scoreboard</a><a id="m-circle">05 The even–odd circle <small>one ring per verse</small></a></nav>
<main><h2 id="view">Map of the Quran</h2></main>
<script>
const e=(n)=>navigator.sendBeacon('/e?n='+encodeURIComponent(n));
const show=()=>{document.getElementById('view').textContent=location.hash==='#circle'?'The even–odd circle':'Map of the Quran'};
addEventListener('hashchange',()=>{e('hash:'+location.hash);show()});show();
document.getElementById('m-circle').onclick=()=>{location.hash='circle';e('menu:circle')};
document.getElementById('m-score').onclick=()=>e('menu:score');
document.getElementById('s').onchange=(ev)=>e('picked:'+ev.target.value);
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
      res.writeHead(200, { 'content-type': 'text/html' }).end(req.url?.startsWith('/study') ? STUDY : APP)
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

  it('opens the whole address, clicks the menu entry named with another dash, and chooses entries in the dropdown, in both passes', async () => {
    events = []
    const study = `${url}study`
    const steps = `1. open: ${study}#circle
2. from the left panel ensure to click SHAPES -> 05 \`The even-odd circle\` option
3. in your own words tell that the verses balance. go to the \`Text to Study\` dropdown in header of the page on top left and select Surah An-Nur, and show the structure. then switch to surah Ya-Sin, then show it
4. then provide a conclusion statement`
    const out = await runAppRecording({ ...base('picks', steps), startUrl: study }, hooks())
    const want = ['hash:#circle', 'picked:24', 'picked:36']
    // the page already shows the view when the address opens it, so the menu entry is clicked as well but is harmless
    expect(events.filter((e) => e.startsWith('hash:') || e.startsWith('picked:'))).toEqual([...want, ...want])
    expect(events.filter((e) => e === 'menu:score').length).toBe(0) // the entry next to it was never pressed
    expect(events.filter((e) => e === 'menu:circle').length).toBe(2)
    expect(out.plan.playbook.steps.filter((s) => s.kind === 'select').map((s) => s.text)).toEqual(['An-Nur', 'Ya-Sin'])
    // one beat for the address, the menu click, the explanation and one for each entry chosen, then the conclusion
    expect(out.plan.beats.map((b) => b.chapter)).toEqual(['Opening page', 'The even-odd circle', 'Explained', 'Switch to An-Nur', 'Switch to Ya-Sin', 'Step 4'])
    expect(out.video).toBeTruthy()
  }, 300000)

  it('skips a step that cannot be done and says so, and the steps after it are still done', async () => {
    events = []
    const out = await runAppRecording({ ...base('missing', '1. click ontology\n2. click "Quantum teleporter"\n3. click ontology'), stopAfter: 'plan' }, hooks())
    expect(events).toEqual(['nav-ontology', 'nav-ontology']) // step 3 was still done
    expect(out.plan.notes.join(' ')).toMatch(/Step 2 was not fully done: clicking "Quantum teleporter" was skipped/)
    // a step that could not be done has no beat (nothing is shown or said about it); the notes list it
    expect(out.plan.beats).toHaveLength(2)
    expect(out.plan.notes.join(' ')).toMatch(/Step 2 \("click "Quantum teleporter""\) was not done at all/)
    expect(out.plan.notes[0]).not.toMatch(/exactly as written/)
  }, 120000)
})

describe('names in quotes keep their brackets', () => {
  it('"Volcano (2D)" is not "Volcano", so the 2D button is told from the 3D one', () => {
    const s = parseStepScript('1. log in\n2. click "Volcano (2D)" and explain that Allah is avoided\n3. click "Wavelet scalogram (3D)"')!
    const labels = s.items.flatMap((i) => i.atoms).filter((a) => a.action === 'click').map((a) => (a as { label: string }).label)
    expect(labels).toEqual(['Volcano (2D)', 'Wavelet scalogram (3D)'])
  })

  it('a position in brackets after the name is still read as a position', () => {
    const s = parseStepScript('1. log in\n2. Click the fit to view icon (just right above the pause icon)')!
    const a = s.items[1].atoms[0] as { label: string; find: { relation?: { rel: string } } }
    expect(a.label).toMatch(/fit to view/)
    expect(a.find.relation?.rel).toBe('above')
  })
})
