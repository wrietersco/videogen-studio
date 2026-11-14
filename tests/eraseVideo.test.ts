import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../src/main/store/projectStore'
import { AssetLibrary } from '../src/main/assets/library'
import { SpendLedgerStore } from '../src/main/usage/spendLedger'
import { eraseProject } from '../src/main/store/erase'

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'vg-erase-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const entry = (kind: string, usd: number, saved = false) => ({ at: 'x', stage: 's', kind, provider: 'p', model: 'm', usage: {}, usd, priced: true, ...(saved ? { saved: true } : {}) })

describe('deleting a video completely', () => {
  it('removes the folder, outside renders and its own library files; keeps shared ones and the cost', () => {
    const store = new ProjectStore(join(root, 'projects'))
    const lib = new AssetLibrary(join(root, 'library'), null)
    const ledger = new SpendLedgerStore(join(root, 'ledger.json'))
    const { id, dir } = store.create('a prompt', 'My film')
    const other = store.create('another', 'Other film')
    const outside = join(root, 'exports', 'my-film.mp4')
    mkdirSync(join(root, 'exports'), { recursive: true })
    writeFileSync(outside, 'video')
    store.addRender(id, outside, 'youtube')
    writeFileSync(join(dir, 'renders', 'r.mp4'), 'x')
    writeFileSync(join(dir, 'usage.json'), JSON.stringify({ runs: [{ kind: 'generate', startedAt: 'a', entries: [entry('text', 0.1), entry('voice', 0.25), entry('image', 0.5, true)], totalUsd: 0.35, savedUsd: 0.5 }], totalUsd: 0.35, savedUsd: 0.5 }))

    const mine = lib.add(Buffer.from('img-mine'), '.png', { kind: 'image', source: 'generated', title: 'mine', tags: [], license: { type: 'generated' } } as never)
    const shared = lib.add(Buffer.from('img-shared'), '.png', { kind: 'image', source: 'generated', title: 'shared', tags: [], license: { type: 'generated' } } as never)
    const upload = lib.add(Buffer.from('img-upload'), '.png', { kind: 'image', source: 'uploaded', title: 'yours', tags: [], license: { type: 'own' } } as never)
    lib.markUsed(mine.id, id); lib.markUsed(shared.id, id); lib.markUsed(shared.id, other.id); lib.markUsed(upload.id, id)

    const res = eraseProject({ store, library: lib, ledger }, id)
    expect(res.ok).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(outside)).toBe(false)
    expect(lib.get(mine.id)).toBeNull()
    expect(readdirSync(join(root, 'library', 'image')).some((f) => f.startsWith(mine.id))).toBe(false)
    expect(lib.get(shared.id)?.usedIn).toEqual([other.id])
    expect(lib.get(upload.id)).not.toBeNull()
    expect(store.list().map((m) => m.id)).toEqual([other.id])
    expect(ledger.read()).toMatchObject({ videos: 1, savedUsd: 0.5 })
    expect(ledger.read().totalUsd).toBeCloseTo(0.35)
    expect(ledger.read().byKind).toEqual({ text: 0.1, voice: 0.25 })
    // nothing but totals in the ledger
    expect(JSON.stringify(ledger.read())).not.toContain('My film')
  })

  it('rejects bad ids and missing videos without touching the ledger', () => {
    const store = new ProjectStore(join(root, 'p2'))
    const ledger = new SpendLedgerStore(join(root, 'l2.json'))
    const lib = new AssetLibrary(join(root, 'lib2'), null)
    expect(eraseProject({ store, library: lib, ledger }, '../x').ok).toBe(false)
    expect(eraseProject({ store, library: lib, ledger }, 'nope').ok).toBe(false)
    expect(ledger.read().videos).toBe(0)
  })
})
