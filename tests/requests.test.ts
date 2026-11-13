import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer as httpServer, type Server } from 'node:http'
import { createServer as netServer, connect as netConnect, type AddressInfo } from 'node:net'
import { clampSeats, openUpgrade, requestLabel, upgradeOutcome } from '@shared/requests'
import { createApp } from '../server/src/app'
import { devVerifier } from '../server/src/auth'
import { MemoryStore } from '../server/src/memoryStore'
import { buildMessage, smtpMailer, type Mail, type Mailer } from '../server/src/mailer'

const NOW = new Date('2026-11-15T12:00:00Z')

describe('requests inbox', () => {
  let server: Server
  let base = ''
  let store: MemoryStore
  let sent: Mail[]
  let mailFails = false
  const token = (uid: string, verified = true) => `dev:${uid}:${uid}@example.com${verified ? ':verified' : ''}`
  const DEVICE = 'device-0001'

  const call = async (path: string, opts: { token?: string; body?: unknown; method?: string; device?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.device ? { 'X-VG-Device': opts.device } : {})
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    })
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }
  const signIn = (uid: string, verified = true) => call('/v1/account/sync', { token: token(uid, verified), body: { device: { id: DEVICE, name: 'PC' } } })
  const ask = (uid: string, body: unknown, verified = true) => call('/v1/requests', { token: token(uid, verified), device: DEVICE, body })
  const mineOf = (uid: string) => call('/v1/requests/mine', { token: token(uid), device: DEVICE })

  beforeEach(async () => {
    store = new MemoryStore()
    store.admins.set('boss', { uid: 'boss', email: 'boss@example.com', role: 'superadmin' })
    sent = []
    mailFails = false
    const mailer: Mailer = {
      async send(m) {
        if (mailFails) throw new Error('smtp down')
        sent.push(m)
      }
    }
    const handler = createApp({ store, verifier: devVerifier, secret: async () => null, now: () => NOW, mailer, notifyTo: 'hello@example.com', consoleUrl: 'https://console.example/console/' })
    server = httpServer((req, res) => void handler(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise((r) => server.close(r))
  })

  it('takes a one-click upgrade request, defaulting to one seat, and mails the owner a console link', async () => {
    await signIn('amy')
    const r = await ask('amy', { kind: 'upgrade', plan: 'pro' })
    expect(r.status).toBe(200)
    expect(r.json.request).toMatchObject({ kind: 'upgrade', plan: 'pro', seats: 1, status: 'open' })
    expect(r.json.requests).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('hello@example.com')
    expect(sent[0].replyTo).toBe('amy@example.com')
    expect(sent[0].text).toContain(`https://console.example/console/#requests/${r.json.request.id}`)
    expect(store.auditLog.map((a) => a.action)).toContain('request_created')
    // the app's own list never leaks the requester's uid
    expect(JSON.stringify((await mineOf('amy')).json)).not.toContain('"uid"')
  })

  it('keeps one open upgrade per account: a new click replaces the old, cancel removes it', async () => {
    await signIn('amy')
    const a = await ask('amy', { kind: 'upgrade', plan: 'plus', seats: 2 })
    const b = await ask('amy', { kind: 'upgrade', plan: 'ultra', seats: 3 })
    const list = (await mineOf('amy')).json.requests
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: b.json.request.id, plan: 'ultra', seats: 3 })
    expect((await store.getRequest(a.json.request.id))!.status).toBe('cancelled')
    const c = await call(`/v1/requests/${b.json.request.id}/cancel`, { token: token('amy'), device: DEVICE, body: {} })
    expect(c.json.requests).toEqual([])
    // cancelling again, or somebody else's request, fails the same way
    expect((await call(`/v1/requests/${b.json.request.id}/cancel`, { token: token('amy'), device: DEVICE, body: {} })).status).toBe(409)
    await signIn('bob')
    const mine = await ask('amy', { kind: 'upgrade', plan: 'plus' })
    expect((await call(`/v1/requests/${mine.json.request.id}/cancel`, { token: token('bob'), device: DEVICE, body: {} })).status).toBe(404)
  })

  it('validates what is sent', async () => {
    await signIn('amy')
    expect((await ask('amy', { kind: 'upgrade', plan: 'free' })).json.error.code).toBe('bad_plan')
    expect((await ask('amy', { kind: 'upgrade', plan: 'pro', seats: 0 })).json.error.code).toBe('bad_seats')
    expect((await ask('amy', { kind: 'upgrade', plan: 'pro', seats: 1.5 })).json.error.code).toBe('bad_seats')
    expect((await ask('amy', { kind: 'upgrade', plan: 'pro', seats: 5000 })).json.error.code).toBe('bad_seats')
    expect((await ask('amy', { kind: 'message', body: '   ' })).json.error.code).toBe('empty_message')
    expect((await ask('amy', { kind: 'nope' })).json.error.code).toBe('bad_kind')
    // lengths are capped, not rejected
    const long = await ask('amy', { kind: 'message', subject: 'x'.repeat(500), body: 'y'.repeat(9000) })
    const rec = (await store.getRequest(long.json.request.id))!
    expect(rec.subject).toHaveLength(120)
    expect(rec.body).toHaveLength(4000)
  })

  it('refuses signed-out callers, unregistered computers and unverified emails', async () => {
    expect((await call('/v1/requests', { body: { kind: 'upgrade', plan: 'pro' } })).status).toBe(401)
    await signIn('amy')
    expect((await call('/v1/requests', { token: token('amy'), device: 'other-device-1', body: { kind: 'upgrade', plan: 'pro' } })).status).toBe(403)
    await signIn('ned', false)
    expect((await ask('ned', { kind: 'upgrade', plan: 'pro' }, false)).json.error.code).toBe('email_unverified')
    expect(store.requests.size).toBe(0)
  })

  it('rate-limits requests and caps open messages', async () => {
    await signIn('amy')
    for (let i = 0; i < 5; i++) expect((await ask('amy', { kind: 'message', body: `hi ${i}` })).status).toBe(200)
    expect((await ask('amy', { kind: 'message', body: 'one more' })).json.error.code).toBe('too_many_open')
    for (let i = 0; i < 5; i++) await ask('amy', { kind: 'upgrade', plan: 'plus' })
    expect((await ask('amy', { kind: 'upgrade', plan: 'plus' })).status).toBe(429)
  })

  it('shows requests only to superadmins', async () => {
    await signIn('amy')
    await ask('amy', { kind: 'upgrade', plan: 'pro' })
    expect((await call('/admin/requests', { token: token('amy') })).status).toBe(403)
    const id = [...store.requests.keys()][0]
    expect((await call(`/admin/requests/${id}/approve`, { token: token('amy'), body: {} })).status).toBe(403)
    expect((await call('/admin/requests', { token: token('boss') })).json.requests).toHaveLength(1)
    expect((await call('/admin/requests', { token: token('boss') })).json.openCount).toBe(1)
  })

  it('approving an upgrade puts the requester on that plan and seat count, with no key to copy', async () => {
    await signIn('amy')
    const r = await ask('amy', { kind: 'upgrade', plan: 'pro', seats: 3 })
    sent.length = 0
    const ok = await call(`/admin/requests/${r.json.request.id}/approve`, { token: token('boss'), body: {} })
    expect(ok.status).toBe(200)
    expect(JSON.stringify(ok.json)).not.toMatch(/vg_live_/)
    const view = (await call('/v1/entitlements', { token: token('amy'), device: DEVICE })).json
    expect(view.entitlements.plan).toBe('pro')
    expect(view.license).toMatchObject({ plan: 'pro', seats: 3 })
    const mine = (await mineOf('amy')).json.requests
    expect(mine[0]).toMatchObject({ status: 'approved', plan: 'pro' })
    expect(sent.map((m) => [m.to, m.subject])).toEqual([['amy@example.com', 'Your VideoGen upgrade is approved']])
    expect(store.auditLog.map((a) => a.action)).toEqual(expect.arrayContaining(['license_created', 'request_approved']))
    // deciding twice is refused
    expect((await call(`/admin/requests/${r.json.request.id}/reject`, { token: token('boss'), body: {} })).status).toBe(409)
    // dismissing the outcome removes it from the app
    const gone = await call(`/v1/requests/${r.json.request.id}/dismiss`, { token: token('amy'), device: DEVICE, body: {} })
    expect(gone.json.requests).toEqual([])
  })

  it('approving for someone already on a licence changes that licence instead of making a second', async () => {
    await signIn('amy')
    const first = await ask('amy', { kind: 'upgrade', plan: 'plus', seats: 1 })
    await call(`/admin/requests/${first.json.request.id}/approve`, { token: token('boss'), body: {} })
    const second = await ask('amy', { kind: 'upgrade', plan: 'ultra', seats: 2 })
    await call(`/admin/requests/${second.json.request.id}/approve`, { token: token('boss'), body: {} })
    expect(store.licenses.size).toBe(1)
    expect([...store.licenses.values()][0]).toMatchObject({ plan: 'ultra', seats: 2 })
    expect((await call('/v1/entitlements', { token: token('amy'), device: DEVICE })).json.entitlements.plan).toBe('ultra')
  })

  it('rejecting stores the reason, tells the requester once, and changes no plan', async () => {
    await signIn('amy')
    const r = await ask('amy', { kind: 'upgrade', plan: 'ultra' })
    sent.length = 0
    const rej = await call(`/admin/requests/${r.json.request.id}/reject`, { token: token('boss'), body: { reason: 'Payment not received yet' } })
    expect(rej.json.request.status).toBe('rejected')
    expect((await mineOf('amy')).json.requests[0]).toMatchObject({ status: 'rejected', reason: 'Payment not received yet' })
    expect(sent[0].text).toContain('Payment not received yet')
    expect(store.licenses.size).toBe(0)
    await call(`/v1/requests/${r.json.request.id}/dismiss`, { token: token('amy'), device: DEVICE, body: {} })
    expect((await mineOf('amy')).json.requests).toEqual([])
  })

  it('handles messages: mark handled, and approve/reject do not apply', async () => {
    await signIn('amy')
    const m = await ask('amy', { kind: 'message', subject: 'Invoice', body: 'Can I get an invoice?' })
    expect(sent[0].subject).toContain('Message: Invoice')
    expect(sent[0].text).toContain('Can I get an invoice?')
    const id = m.json.request.id
    expect((await call(`/admin/requests/${id}/approve`, { token: token('boss'), body: {} })).json.error.code).toBe('not_an_upgrade')
    expect((await call(`/admin/requests/${id}/handled`, { token: token('boss'), body: {} })).json.request.status).toBe('handled')
    expect((await mineOf('amy')).json.requests).toEqual([])
    const up = await ask('amy', { kind: 'upgrade', plan: 'plus' })
    expect((await call(`/admin/requests/${up.json.request.id}/handled`, { token: token('boss'), body: {} })).json.error.code).toBe('not_a_message')
    expect((await call('/admin/requests?status=handled', { token: token('boss') })).json.requests).toHaveLength(1)
    expect((await call('/admin/requests?status=bogus', { token: token('boss') })).status).toBe(400)
  })

  it('never loses a request when mail fails, and works with no mailer at all', async () => {
    await signIn('amy')
    mailFails = true
    const r = await ask('amy', { kind: 'upgrade', plan: 'pro' })
    expect(r.status).toBe(200)
    expect(store.requests.size).toBe(1)
    expect(store.auditLog.map((a) => a.action)).toContain('mail_failed')

    const bare = createApp({ store, verifier: devVerifier, secret: async () => null, now: () => NOW })
    const s2 = httpServer((req, res) => void bare(req, res))
    await new Promise<void>((res) => s2.listen(0, '127.0.0.1', res))
    const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`
    const out = await fetch(`${b2}/v1/requests`, { method: 'POST', headers: { Authorization: `Bearer ${token('amy')}`, 'X-VG-Device': DEVICE, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'message', body: 'hello' }) })
    expect(out.status).toBe(200)
    await new Promise((res) => s2.close(res))
  })

  it('labels requests in plain words', () => {
    expect(requestLabel({ kind: 'upgrade', plan: 'plus', seats: 1 })).toBe('Plus upgrade, 1 seat')
    expect(requestLabel({ kind: 'upgrade', plan: 'ultra', seats: 4 })).toBe('Ultra upgrade, 4 seats')
    expect(requestLabel({ kind: 'message', subject: '' })).toBe('Message: (no subject)')
  })
})

describe('SMTP mailer', () => {
  /** a fake mail server that records what the client says, speaking plain TCP */
  async function fakeServer(reply: (line: string, state: { inData: boolean }) => string | null) {
    const lines: string[] = []
    const srv = netServer((sock) => {
      const state = { inData: false }
      sock.write('220 fake ready\r\n')
      let buf = ''
      sock.on('data', (d) => {
        buf += d.toString('utf8')
        let i: number
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 2)
          lines.push(line)
          const out = reply(line, state)
          if (out) sock.write(out)
        }
      })
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    return { srv, lines, port: (srv.address() as AddressInfo).port }
  }
  const happy = (line: string, st: { inData: boolean }): string | null => {
    if (st.inData) {
      if (line === '.') {
        st.inData = false
        return '250 queued\r\n'
      }
      return null
    }
    if (line.startsWith('EHLO')) return '250-fake\r\n250 AUTH LOGIN\r\n'
    if (line === 'AUTH LOGIN') return '334 VXNlcm5hbWU6\r\n'
    if (line === Buffer.from('hello@example.com').toString('base64')) return '334 UGFzc3dvcmQ6\r\n'
    if (line === Buffer.from('test-password').toString('base64')) return '235 ok\r\n'
    if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) return '250 ok\r\n'
    if (line === 'DATA') {
      st.inData = true
      return '354 go\r\n'
    }
    if (line === 'QUIT') return '221 bye\r\n'
    return '500 what\r\n'
  }
  const opts = (port: number, password: () => Promise<string | null>) => ({
    host: '127.0.0.1',
    port,
    user: 'hello@example.com',
    from: 'hello@example.com',
    password,
    connect: (h: string, p: number) => netConnect({ host: h, port: p }),
    timeoutMs: 3000
  })

  it('delivers a message with login, headers and an encoded body', async () => {
    const f = await fakeServer(happy)
    await smtpMailer(opts(f.port, async () => 'test-password')).send({ to: 'a@b.co', replyTo: 'c@d.co', subject: 'Héllo\r\nBcc: evil@x.co', text: 'Line one\n.dot line' })
    f.srv.close()
    const all = f.lines.join('\n')
    expect(all).toContain('MAIL FROM:<hello@example.com>')
    expect(all).toContain('RCPT TO:<a@b.co>')
    expect(all).toContain('Reply-To: c@d.co')
    // a newline in the subject cannot start a new header
    expect(f.lines.some((l) => l.startsWith('Bcc:'))).toBe(false)
    const body = f.lines.slice(f.lines.indexOf('') + 1).filter((l) => l !== '.' && l !== 'QUIT').join('')
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('Line one\n.dot line')
  })

  it('skips quietly when there is no password, and reports a server refusal', async () => {
    const f = await fakeServer(happy)
    await smtpMailer(opts(f.port, async () => null)).send({ to: 'a@b.co', subject: 's', text: 't' })
    expect(f.lines).toHaveLength(0)
    f.srv.close()
    const bad = await fakeServer((line) => (line.startsWith('EHLO') ? '250 hi\r\n' : line === 'AUTH LOGIN' ? '334 x\r\n' : line.length > 12 && !line.includes(' ') && line === Buffer.from('hello@example.com').toString('base64') ? '334 y\r\n' : '535 bad login\r\n'))
    await expect(smtpMailer(opts(bad.port, async () => 'wrong')).send({ to: 'a@b.co', subject: 's', text: 't' })).rejects.toThrow(/535/)
    bad.srv.close()
  })

  it('builds a message that is plain base64 text with safe headers', () => {
    const m = buildMessage('me@x.co', { to: 'you@x.co', subject: 'Plain', text: 'hi' }, NOW)
    expect(m).toContain('Subject: Plain')
    expect(m).toContain('Content-Transfer-Encoding: base64')
  })
})

describe('app request helpers', () => {
  const r = (over: object) => ({ id: 'req_1', kind: 'upgrade', status: 'open', plan: 'pro', seats: 1, createdAt: '2026-11-15T00:00:00Z', ...over }) as any
  it('finds the one open upgrade and the outcome to show', () => {
    expect(openUpgrade([r({ kind: 'message' }), r({ id: 'req_2' })])?.id).toBe('req_2')
    expect(openUpgrade([r({ status: 'approved' })])).toBeUndefined()
    expect(upgradeOutcome([r({ status: 'rejected', reason: 'no' })])?.reason).toBe('no')
    expect(upgradeOutcome([r({})])).toBeUndefined()
  })
  it('keeps the seat stepper between 1 and the cap', () => {
    expect([clampSeats(0), clampSeats(-3), clampSeats(2.7), clampSeats(99999), clampSeats(NaN)]).toEqual([1, 1, 2, 1000, 1])
  })
})
