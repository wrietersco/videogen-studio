// `npm run dev`: the server on 127.0.0.1:8787 with an in-memory store and dev tokens.
process.env.VG_STORE = 'memory'
process.env.VG_DEV_AUTH = '1'
process.env.PORT ??= '8787'
await import('./index')
export {}
