/*
 * VideoGen superadmin console. Talks only to this server's /admin API with the
 * signed-in admin's Firebase ID token; it has no Firestore access of its own,
 * so the server's checks (vg_admins allow-list, revocation, validation, audit
 * log) are the only way anything changes. All text is set with textContent.
 */

const $ = (id) => document.getElementById(id)
const PLAN_IDS = ['free', 'plus', 'pro', 'ultra']
const KINDS = ['chat', 'image', 'voice', 'music', 'video']

let getToken = async () => { throw new Error('Not signed in') }
let signOutFn = async () => {}
let overview = null
let policy = null
let defaults = null

// ---------------- dom helpers ----------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  return el
}
const money = (v) => `$${Number(v || 0).toFixed(Number(v) < 1 ? 3 : 2)}`
const day = (iso) => (iso ? String(iso).slice(0, 10) : '—')
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—')
const pill = (state) => h('span', { class: `pill ${state}` }, String(state).replace('_', ' '))

function flash(message, bad = false) {
  const f = $('flash')
  f.textContent = message
  f.className = `flash${bad ? ' bad' : ''}`
  clearTimeout(flash.t)
  flash.t = setTimeout(() => f.classList.add('hidden'), 6000)
}

// ---------------- api ----------------

async function api(path, body) {
  const res = await fetch(`/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${await getToken()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.error?.message || `Request failed (${res.status})`)
  return json
}

async function guarded(fn) {
  try {
    return await fn()
  } catch (e) {
    flash(e.message, true)
  }
}

// ---------------- sign-in ----------------

async function setupAuth() {
  const config = await (await fetch('/console/config.json')).json()
  if (config.devAuth) {
    $('google-btn').classList.add('hidden')
    $('dev-row').classList.remove('hidden')
    let devToken = ''
    getToken = async () => devToken
    signOutFn = async () => { devToken = ''; showLogin() }
    $('login-form').onsubmit = async (e) => {
      e.preventDefault()
      devToken = $('dev-token').value.trim()
      await enter($('email').value || 'dev')
    }
    return
  }
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js')
  const fa = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js')
  const auth = fa.getAuth(initializeApp({ apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId }))
  getToken = async () => {
    if (!auth.currentUser) throw new Error('Not signed in')
    return auth.currentUser.getIdToken()
  }
  signOutFn = () => fa.signOut(auth)
  $('google-btn').onclick = async () => {
    $('login-error').textContent = ''
    try {
      await fa.signInWithPopup(auth, new fa.GoogleAuthProvider())
    } catch (err) {
      const code = err?.code || 'unknown'
      $('login-error').textContent =
        code === 'auth/unauthorized-domain' ? 'This address is not yet allowed for Google sign-in (Firebase → Authentication → Settings → Authorized domains).'
        : code === 'auth/popup-blocked' ? 'The browser blocked the Google window. Allow pop-ups for this site and try again.'
        : code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' ? 'The Google window was closed before sign-in finished.'
        : `Google sign-in failed (${code}).`
    }
  }
  $('login-form').onsubmit = async (e) => {
    e.preventDefault()
    $('login-error').textContent = ''
    try {
      await fa.signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value)
    } catch (err) {
      $('login-error').textContent = `Sign-in failed (${err?.code || 'unknown'}). Check the email and password.`
    }
  }
  fa.onAuthStateChanged(auth, (user) => (user ? enter(user.email) : showLogin()))
}

function showLogin() {
  $('login').classList.remove('hidden')
  $('app').classList.add('hidden')
  $('logout').classList.add('hidden')
  $('whoami').textContent = ''
}

async function enter(email) {
  try {
    const me = await api('/me')
    $('whoami').textContent = me.email || email
  } catch (e) {
    $('login-error').textContent = e.message
    await signOutFn()
    return
  }
  $('login').classList.add('hidden')
  $('app').classList.remove('hidden')
  $('logout').classList.remove('hidden')
  await loadOverview()
  void refreshBadge()
  void openFromHash()
}

// ---------------- tabs ----------------

function showTab(name) {
  for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x.dataset.tab === name)
  for (const p of document.querySelectorAll('[data-panel]')) p.classList.toggle('hidden', p.dataset.panel !== name)
  if (name === 'requests') void loadRequests()
  if (name === 'users') void loadUsers()
  if (name === 'plans') void loadPolicy()
  if (name === 'audit') void loadAudit()
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab))
$('logout').onclick = () => signOutFn()

// ---------------- licences ----------------

async function loadOverview() {
  await guarded(async () => {
    overview = await api('/overview')
    policy = overview.policy
    renderStats()
    renderLicenses()
  })
}

function renderStats() {
  const t = overview.totals
  const margin = t.revenueUsdMonthly - t.costUsdThisMonth
  $('stats').replaceChildren(
    ...[
      [t.licenses, 'licences'],
      [t.users, `accounts (${t.freeUsers} free)`],
      [t.freeAiVideosThisMonth, 'free AI videos this month'],
      [money(t.revenueUsdMonthly), 'revenue / month'],
      [money(t.costUsdThisMonth), `AI cost in ${overview.month}`],
      [money(margin), 'margin so far']
    ].map(([v, l]) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, l)))
  )
}

function planOptions(select, value) {
  select.replaceChildren(...PLAN_IDS.map((id) => h('option', { value: id, selected: id === value }, `${policy?.plans?.[id]?.label ?? id} — $${policy?.plans?.[id]?.priceUsdMonthly ?? 0}/mo`)))
}

function renderLicenses() {
  const q = $('lic-filter').value.trim().toLowerCase()
  const rows = overview.licenses.filter((l) => !q || `${l.customerName} ${l.plan} ${l.contactEmail} ${l.keyHint}`.toLowerCase().includes(q))
  $('lic-body').replaceChildren(
    ...(rows.length ? rows : [null]).map((l) => {
      if (!l) return h('tr', {}, h('td', { colspan: 9, class: 'dim' }, 'No licences yet.'))
      const tr = h(
        'tr',
        {},
        h('td', {}, l.customerName || '(no name)', h('div', { class: 'sub' }, l.contactEmail || '', ' · ', l.keyHint)),
        h('td', {}, policy.plans[l.plan]?.label ?? l.plan, l.allowOwnKeys ? h('div', { class: 'sub' }, 'own keys allowed') : null),
        h('td', {}, `${l.members} / ${l.seats}`),
        h('td', {}, pill(l.status === 'suspended' ? 'suspended' : l.access.state), l.access.reason ? h('div', { class: 'sub' }, l.access.reason) : null),
        h('td', {}, day(l.paidThrough)),
        h('td', {}, `${l.aiVideosUsed} / ${l.aiVideosPerMonth ?? '∞'}`),
        h('td', {}, money(l.costUsd)),
        h('td', {}, money(l.revenueUsdMonthly)),
        h('td', {}, h('button', { class: 'ghost sm', onclick: () => toggleEdit(tr, l) }, 'Edit'))
      )
      return tr
    })
  )
}
$('lic-filter').oninput = () => overview && renderLicenses()

function toggleEdit(tr, l) {
  if (tr.nextSibling?.classList?.contains('edit-row')) return tr.nextSibling.remove()
  const f = (name, input) => h('label', {}, name, input)
  const plan = h('select', { name: 'plan' })
  planOptions(plan, l.plan)
  const o = l.overrides || {}
  const form = h(
    'form',
    { class: 'grid' },
    f('Customer', h('input', { name: 'customerName', value: l.customerName })),
    f('Contact email', h('input', { name: 'contactEmail', type: 'email', value: l.contactEmail })),
    f('Plan', plan),
    f('Seats', h('input', { name: 'seats', type: 'number', min: 1, max: 1000, value: l.seats })),
    f('Paid through', h('input', { name: 'paidThrough', type: 'date', value: l.paidThrough ? l.paidThrough.slice(0, 10) : '' })),
    f('Revenue / month ($)', h('input', { name: 'revenueUsdMonthly', type: 'number', min: 0, step: 0.01, value: l.revenueUsdMonthly })),
    f('Own API keys', h('select', { name: 'allowOwnKeys' }, h('option', { value: 'false', selected: !l.allowOwnKeys }, 'Not allowed'), h('option', { value: 'true', selected: l.allowOwnKeys }, 'Allowed'))),
    f('AI videos / month (override)', h('input', { name: 'ov_aiVideosPerMonth', type: 'number', min: 0, placeholder: 'plan × seats', value: o.aiVideosPerMonth ?? '' })),
    f('Clips / video (override)', h('input', { name: 'ov_clipsPerVideo', type: 'number', min: 0, max: 12, placeholder: 'plan', value: o.clipsPerVideo ?? '' })),
    f('Monthly AI $ cap (override)', h('input', { name: 'ov_costCapUsdPerMonth', type: 'number', min: 0, step: 0.5, placeholder: 'plan × seats', value: o.costCapUsdPerMonth ?? '' })),
    h('label', { class: 'wide' }, 'Notes', h('input', { name: 'notes', value: l.notes })),
    h(
      'div',
      { class: 'actions wide' },
      h('button', { type: 'submit' }, 'Save'),
      h('button', { type: 'button', class: l.status === 'suspended' ? 'ghost' : 'danger', onclick: () => setStatus(l, l.status === 'suspended' ? 'active' : 'suspended') }, l.status === 'suspended' ? 'Reactivate' : 'Suspend'),
      h('button', { type: 'button', class: 'ghost', onclick: () => rotate(l) }, 'Issue a new key (old one stops working)')
    )
  )
  form.onsubmit = (e) => {
    e.preventDefault()
    const d = Object.fromEntries(new FormData(form))
    void guarded(async () => {
      await api('/licenses/update', {
        id: l.id,
        customerName: d.customerName,
        contactEmail: d.contactEmail,
        plan: d.plan,
        seats: Number(d.seats),
        paidThrough: d.paidThrough || null,
        revenueUsdMonthly: Number(d.revenueUsdMonthly || 0),
        allowOwnKeys: d.allowOwnKeys === 'true',
        notes: d.notes,
        overrides: { aiVideosPerMonth: d.ov_aiVideosPerMonth, clipsPerVideo: d.ov_clipsPerVideo, costCapUsdPerMonth: d.ov_costCapUsdPerMonth }
      })
      flash('Licence saved.')
      await loadOverview()
    })
  }
  tr.after(h('tr', { class: 'edit-row' }, h('td', { colspan: 9 }, form)))
}

async function setStatus(l, status) {
  if (status === 'suspended' && !confirm(`Suspend ${l.customerName || 'this licence'}? Its AI videos stop immediately.`)) return
  await guarded(async () => {
    await api('/licenses/update', { id: l.id, status })
    flash(status === 'suspended' ? 'Licence suspended.' : 'Licence reactivated.')
    await loadOverview()
  })
}

async function rotate(l) {
  if (!confirm('Issue a new key? The current key stops working at once; people already signed in stay linked.')) return
  await guarded(async () => {
    const r = await api('/licenses/rotate', { id: l.id })
    showKey(r.licenseKey, r.license.customerName)
    await loadOverview()
  })
}

function showKey(key, who) {
  const box = $('key-box')
  box.replaceChildren(
    h('b', {}, `Licence key for ${who || 'this customer'} — shown once, copy it now`),
    h('code', {}, key),
    h('div', { class: 'actions' }, h('button', { class: 'sm', onclick: () => navigator.clipboard.writeText(key).then(() => flash('Key copied.')) }, 'Copy'), h('button', { class: 'ghost sm', onclick: () => box.classList.add('hidden') }, 'Done, hide it'))
  )
  box.classList.remove('hidden')
}

$('lic-new').onclick = () => {
  planOptions($('lic-form').plan, 'plus')
  $('lic-form').classList.toggle('hidden')
}
$('lic-cancel').onclick = () => $('lic-form').classList.add('hidden')
$('lic-form').onsubmit = (e) => {
  e.preventDefault()
  const d = Object.fromEntries(new FormData($('lic-form')))
  void guarded(async () => {
    const r = await api('/licenses', {
      customerName: d.customerName,
      contactEmail: d.contactEmail,
      plan: d.plan,
      seats: Number(d.seats || 1),
      paidThrough: d.paidThrough || null,
      revenueUsdMonthly: Number(d.revenueUsdMonthly || 0),
      allowOwnKeys: d.allowOwnKeys === 'true',
      notes: d.notes
    })
    $('lic-form').reset()
    $('lic-form').classList.add('hidden')
    showKey(r.licenseKey, r.license.customerName)
    await loadOverview()
  })
}

// ---------------- users ----------------

async function loadUsers() {
  await guarded(async () => {
    const q = $('user-q').value.trim()
    const r = await api(`/users${q ? `?q=${encodeURIComponent(q)}` : ''}`)
    $('user-body').replaceChildren(
      ...(r.users.length ? r.users : [null]).map((u) => {
        if (!u) return h('tr', {}, h('td', { colspan: 9, class: 'dim' }, 'No users found.'))
        const tr = h(
          'tr',
          {},
          h('td', {}, u.email, h('div', { class: 'sub' }, u.uid)),
          h('td', {}, policy?.plans?.[u.plan]?.label ?? u.plan, u.trialActive ? h('div', { class: 'sub' }, `trial to ${day(u.trialEndsAt)}`) : null, u.licenseId ? h('div', { class: 'sub' }, u.licenseId) : null),
          h('td', {}, u.emailVerified ? 'yes' : 'no'),
          h('td', {}, `${u.aiVideosUsed} / ${u.aiVideosPerMonth ?? '∞'}`),
          h('td', {}, money(u.costUsd)),
          h('td', {}, String(u.devices)),
          h('td', {}, pill(u.status)),
          h('td', {}, when(u.lastSeenAt)),
          h('td', {}, h('button', { class: 'ghost sm', onclick: () => userActions(tr, u) }, 'Manage'))
        )
        return tr
      })
    )
  })
}
$('user-search').onclick = () => loadUsers()
$('user-q').onkeydown = (e) => e.key === 'Enter' && loadUsers()

async function userActions(tr, u) {
  if (tr.nextSibling?.classList?.contains('edit-row')) return tr.nextSibling.remove()
  const r = await guarded(() => api(`/users/devices?uid=${encodeURIComponent(u.uid)}`))
  const devices = r?.devices ?? []
  const update = (patch, msg) =>
    guarded(async () => {
      await api('/users/update', { uid: u.uid, ...patch })
      flash(msg)
      await loadUsers()
    })
  tr.after(
    h(
      'tr',
      { class: 'edit-row' },
      h(
        'td',
        { colspan: 9 },
        h(
          'div',
          { class: 'actions' },
          h('button', { class: u.status === 'blocked' ? 'ghost sm' : 'danger sm', onclick: () => update({ status: u.status === 'blocked' ? 'active' : 'blocked' }, u.status === 'blocked' ? 'Account unblocked.' : 'Account blocked.') }, u.status === 'blocked' ? 'Unblock' : 'Block account'),
          u.licenseId ? h('button', { class: 'ghost sm', onclick: () => update({ licenseId: null }, 'Removed from the licence; the seat is free.') }, 'Remove from licence') : null,
          u.trialActive ? h('button', { class: 'ghost sm', onclick: () => update({ trialEndsAt: new Date().toISOString() }, 'Trial ended.') }, 'End trial') : null
        ),
        h('h3', {}, 'Computers'),
        devices.length
          ? h(
              'table',
              {},
              ...devices.map((d) =>
                h(
                  'tr',
                  {},
                  h('td', {}, d.name || d.id, h('div', { class: 'sub' }, `${d.platform} · v${d.appVersion}`)),
                  h('td', {}, `first ${when(d.firstSeenAt)}`),
                  h('td', {}, `last ${when(d.lastSeenAt)}`),
                  h('td', {}, h('button', { class: 'ghost sm', onclick: () => guarded(async () => { await api('/users/devices/remove', { uid: u.uid, deviceId: d.id }); flash('Computer removed.'); await loadUsers() }) }, 'Remove'))
                )
              )
            )
          : h('p', { class: 'dim' }, 'No computers registered.')
      )
    )
  )
}

// ---------------- plans & quotas ----------------

const PLAN_FIELDS = [
  ['label', 'Name', 'text'],
  ['priceUsdMonthly', 'Price / month ($)', 'number'],
  ['aiVideosPerMonth', 'AI videos / month per seat (empty = unlimited)', 'number'],
  ['chatModel', 'Main chat model', 'text'],
  ['clipsPerVideo', 'Animated clips / video', 'number'],
  ['maxVideoSeconds', 'Longest AI video (s)', 'number'],
  ['costCapUsdPerVideo', 'AI $ cap per video', 'number'],
  ['costCapUsdPerMonth', 'AI $ cap per seat / month', 'number'],
  ['utilityUsdPerDay', 'Helper AI $ / day', 'number']
]

async function loadPolicy() {
  await guarded(async () => {
    const r = await api('/policy')
    policy = r.policy
    defaults = r.defaults
    renderPolicy(policy)
  })
}

function renderPolicy(p) {
  const head = h('tr', {}, h('th', {}, ''), ...PLAN_IDS.map((id) => h('th', {}, p.plans[id].label)))
  const rows = PLAN_FIELDS.map(([field, label, type]) =>
    h('tr', {}, h('th', {}, label), ...PLAN_IDS.map((id) => h('td', {}, h('input', { 'data-plan': id, 'data-field': field, type, step: type === 'number' ? 'any' : undefined, value: p.plans[id][field] ?? '' }))))
  )
  const modelRows = KINDS.map((kind) =>
    h('tr', {}, h('th', {}, `${kind} models`), ...PLAN_IDS.map((id) => h('td', {}, h('textarea', { 'data-plan': id, 'data-models': kind }, p.plans[id].models[kind].join(', ')))))
  )
  $('plans-editor').replaceChildren(h('table', { class: 'plan-table' }, h('thead', {}, head), h('tbody', {}, ...rows, ...modelRows)))
  const rule = (label, key, value, attrs = {}) => h('label', {}, label, h('input', { 'data-rule': key, value, ...attrs }))
  const trialPlan = h('select', { 'data-rule': 'trial.plan' }, ...PLAN_IDS.map((id) => h('option', { value: id, selected: id === p.trial.plan }, p.plans[id].label)))
  $('rules-editor').replaceChildren(
    rule('Trial days for new accounts (0 = off)', 'trial.days', p.trial.days, { type: 'number', min: 0 }),
    h('label', {}, 'Trial gives the models of', trialPlan),
    rule('AI videos during the trial', 'trial.aiVideos', p.trial.aiVideos, { type: 'number', min: 0 }),
    rule('Grace days after a missed payment', 'graceDays', p.graceDays, { type: 'number', min: 0 }),
    rule('Then days on Free before AI stops', 'freeFallbackDays', p.freeFallbackDays, { type: 'number', min: 0 }),
    rule('Computers per account', 'devicesPerSeat', p.devicesPerSeat, { type: 'number', min: 1 }),
    h('label', {}, 'Verified email needed for AI', h('select', { 'data-rule': 'requireVerifiedEmail' }, h('option', { value: 'true', selected: p.requireVerifiedEmail }, 'Yes'), h('option', { value: 'false', selected: !p.requireVerifiedEmail }, 'No')))
  )
}

function readPolicy() {
  const plans = {}
  for (const id of PLAN_IDS) plans[id] = { models: {} }
  for (const el of document.querySelectorAll('[data-field]')) {
    const v = el.value.trim()
    const numeric = el.type === 'number'
    plans[el.dataset.plan][el.dataset.field] = numeric ? (v === '' ? (el.dataset.field === 'aiVideosPerMonth' ? null : undefined) : Number(v)) : v
  }
  for (const el of document.querySelectorAll('[data-models]')) {
    plans[el.dataset.plan].models[el.dataset.models] = el.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  }
  const rules = {}
  for (const el of document.querySelectorAll('[data-rule]')) rules[el.dataset.rule] = el.value
  return {
    plans,
    trial: { days: Number(rules['trial.days']), plan: rules['trial.plan'], aiVideos: Number(rules['trial.aiVideos']) },
    graceDays: Number(rules.graceDays),
    freeFallbackDays: Number(rules.freeFallbackDays),
    devicesPerSeat: Number(rules.devicesPerSeat),
    requireVerifiedEmail: rules.requireVerifiedEmail === 'true'
  }
}

$('plans-save').onclick = () =>
  guarded(async () => {
    const r = await api('/policy', { policy: readPolicy() })
    policy = r.policy
    renderPolicy(policy)
    flash('Plans saved. Accounts pick them up within a minute.')
  })
$('plans-reset').onclick = () => {
  if (defaults) renderPolicy(defaults)
  flash('Recommended values filled in. Press Save plans to apply them.')
}

// ---------------- requests ----------------

let focusRequest = null

function describeRequest(r) {
  if (r.kind === 'upgrade') return h('div', {}, h('b', {}, `${r.plan} upgrade`), ` for ${r.seats} seat${r.seats === 1 ? '' : 's'}`)
  return h('div', {}, h('b', {}, r.subject || '(no subject)'), h('div', { class: 'dim', style: 'white-space:pre-wrap;max-width:520px' }, r.body || ''))
}

async function decide(r, action) {
  let reason
  if (action === 'reject') {
    reason = prompt('Why not? (optional, the person sees this)', '')
    if (reason === null) return
  } else if (action === 'approve' && !confirm(`Approve ${r.plan} for ${r.seats} seat${r.seats === 1 ? '' : 's'} for ${r.email}? They get the plan straight away.`)) return
  await guarded(async () => {
    await api(`/requests/${encodeURIComponent(r.id)}/${action}`, action === 'reject' ? { reason } : {})
    flash(action === 'approve' ? 'Approved. They are on the plan now.' : action === 'reject' ? 'Rejected.' : 'Marked handled.')
    await loadRequests()
  })
}

async function loadRequests() {
  await guarded(async () => {
    const status = focusRequest ? 'all' : $('req-status').value
    const r = await api(`/requests?status=${encodeURIComponent(status)}`)
    setBadge(r.openCount)
    $('req-empty').classList.toggle('hidden', r.requests.length > 0)
    const rows = r.requests.map((q) => {
      const actions = q.status !== 'open' ? [h('span', { class: 'dim' }, q.decidedBy ? `by ${q.decidedBy}` : '')] : q.kind === 'upgrade'
        ? [h('button', { class: 'sm', onclick: () => decide(q, 'approve') }, 'Approve'), ' ', h('button', { class: 'ghost sm', onclick: () => decide(q, 'reject') }, 'Reject')]
        : [h('button', { class: 'sm', onclick: () => decide(q, 'handled') }, 'Mark handled'), ' ', h('a', { class: 'sm', href: `mailto:${q.email}` }, 'Reply')]
      return h('tr', { id: `req-${q.id}`, class: q.id === focusRequest ? 'focus' : '' }, h('td', {}, when(q.createdAt)), h('td', {}, q.email), h('td', {}, describeRequest(q), q.reason ? h('div', { class: 'dim' }, `Reason: ${q.reason}`) : null), h('td', {}, pill(q.status)), h('td', {}, ...actions))
    })
    $('req-body').replaceChildren(...rows)
    if (focusRequest) {
      const el = document.getElementById(`req-${focusRequest}`)
      if (el) el.scrollIntoView({ block: 'center' })
      else flash('That request was not found.', true)
      focusRequest = null
    }
  })
}

function setBadge(n) {
  const b = $('req-badge')
  b.textContent = String(n)
  b.classList.toggle('hidden', !n)
}
async function refreshBadge() {
  try {
    setBadge((await api('/requests?status=open')).openCount)
  } catch {
    /* the badge is a convenience */
  }
}

/** #requests/<id> opens that request, from the link in the notification email */
async function openFromHash() {
  const m = /^#requests(?:\/([A-Za-z0-9_-]{1,40}))?$/.exec(location.hash)
  if (!m) return
  focusRequest = m[1] ?? null
  if (!focusRequest) $('req-status').value = 'open'
  showTab('requests')
}
window.addEventListener('hashchange', () => !$('app').classList.contains('hidden') && void openFromHash())
$('req-status').onchange = () => loadRequests()
$('req-refresh').onclick = () => loadRequests()

// ---------------- audit ----------------

async function loadAudit() {
  await guarded(async () => {
    const r = await api('/audit?limit=200')
    $('audit-body').replaceChildren(
      ...r.entries.map((a) =>
        h('tr', {}, h('td', {}, when(a.at)), h('td', {}, a.actor), h('td', {}, a.action.replaceAll('_', ' ')), h('td', {}, a.target ?? ''), h('td', {}, h('details', {}, h('summary', {}, 'details'), h('pre', {}, JSON.stringify(a.details, null, 2)))))
      )
    )
  })
}
$('audit-refresh').onclick = () => loadAudit()

void setupAuth()
