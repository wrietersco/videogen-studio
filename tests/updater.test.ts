import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.3.2', isPackaged: true, getPath: () => '.', quit: () => {} } }))

import { compareVersions, pickInstaller } from '../src/main/updater'

describe('updater', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('0.3.10', '0.3.2')).toBe(1)
    expect(compareVersions('v0.4.0', '0.3.9')).toBe(1)
    expect(compareVersions('0.3.2', '0.3.2')).toBe(0)
    expect(compareVersions('0.3', '0.3.1')).toBe(-1)
    expect(compareVersions('1.0.0-beta', '0.9.9')).toBe(1)
  })
  it('picks the Windows installer asset', () => {
    const a = (name: string) => ({ name, size: 1, browser_download_url: 'x' })
    expect(pickInstaller([a('notes.txt'), a('VideoGen-Studio-Setup-0.4.0.exe')])?.name).toBe('VideoGen-Studio-Setup-0.4.0.exe')
    expect(pickInstaller([a('source.zip')])).toBeNull()
    expect(pickInstaller(undefined)).toBeNull()
  })
})
