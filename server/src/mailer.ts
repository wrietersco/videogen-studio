import { connect as tlsConnect } from 'node:tls'
import type { Socket } from 'node:net'

/**
 * Outgoing mail. The server only ever sends two kinds of note: "someone asked
 * for something" to the owner's inbox, and "your request was decided" to the
 * requester. The Mailer interface is injected so tests use a fake and a server
 * with no mail secret simply skips mail (the request is saved either way).
 */

export interface Mail {
  to: string
  subject: string
  text: string
  replyTo?: string
}

export interface Mailer {
  send(mail: Mail): Promise<void>
}

export interface SmtpOptions {
  host: string
  port: number
  user: string
  from: string
  /** called at send time, so the password is never held in config; null = mail is switched off */
  password: () => Promise<string | null>
  /** test seam: a plain socket to a fake server instead of TLS to the real one */
  connect?: (host: string, port: number) => Socket
  timeoutMs?: number
}

const clean = (v: string): string => v.replace(/[\r\n]+/g, ' ').trim()
const encodeHeader = (v: string): string => (/^[\x20-\x7e]*$/.test(v) ? clean(v) : `=?UTF-8?B?${Buffer.from(clean(v), 'utf8').toString('base64')}?=`)
const addr = (v: string): string => clean(v).replace(/[<>"]/g, '')

export function buildMessage(from: string, mail: Mail, now: Date): string {
  const lines = [
    `From: ${addr(from)}`,
    `To: ${addr(mail.to)}`,
    ...(mail.replyTo ? [`Reply-To: ${addr(mail.replyTo)}`] : []),
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${now.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    ...(Buffer.from(mail.text, 'utf8').toString('base64').match(/.{1,76}/g) ?? [])
  ]
  return lines.join('\r\n')
}

/** a minimal SMTP client: implicit TLS, AUTH LOGIN, one message per connection */
export function smtpMailer(opts: SmtpOptions): Mailer {
  return {
    async send(mail) {
      const password = await opts.password()
      if (!password) return // not configured: skipped on purpose
      const socket = opts.connect ? opts.connect(opts.host, opts.port) : tlsConnect({ host: opts.host, port: opts.port, servername: opts.host })
      await new Promise<void>((resolve, reject) => {
        let buf = ''
        let step = 0
        const timer = setTimeout(() => fail(new Error('mail server timed out')), opts.timeoutMs ?? 20_000)
        const done = () => {
          clearTimeout(timer)
          socket.destroy()
          resolve()
        }
        const fail = (e: Error) => {
          clearTimeout(timer)
          socket.destroy()
          reject(e)
        }
        const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
        const message = buildMessage(opts.from, mail, new Date())
        // [expected reply code, next command]
        const script: Array<[number, string | null]> = [
          [220, `EHLO videogen-license-server`],
          [250, 'AUTH LOGIN'],
          [334, b64(opts.user)],
          [334, b64(password)],
          [235, `MAIL FROM:<${addr(opts.from)}>`],
          [250, `RCPT TO:<${addr(mail.to)}>`],
          [250, 'DATA'],
          [354, `${message.replace(/^\./gm, '..')}\r\n.`],
          [250, 'QUIT'],
          [221, null]
        ]
        socket.setEncoding('utf8')
        socket.on('error', fail)
        socket.on('close', () => step < script.length && fail(new Error('mail server closed the connection early')))
        socket.on('data', (chunk: string) => {
          buf += chunk
          // a reply is finished by a line whose 4th character is a space ("250 OK")
          for (;;) {
            const m = /(?:^|\r?\n)(\d{3}) [^\r\n]*\r?\n/.exec(buf)
            if (!m) return
            buf = buf.slice(m.index + m[0].length)
            const [expected, next] = script[step]
            if (Number(m[1]) !== expected) return fail(new Error(`mail server said ${m[1]} (expected ${expected})`))
            step++
            if (next === null) return done()
            socket.write(`${next}\r\n`)
          }
        })
      })
    }
  }
}
