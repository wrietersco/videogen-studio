import { BrowserWindow, dialog, ipcMain } from 'electron'
import { inspectRef, RefError, type InspectedRef } from './intake'
import type { VideoBrief } from '@shared/spec'
import { VIDEO_EXTENSIONS } from '@shared/footage'
import { providerRegistry } from '../providers/registry'
import type { GeminiProvider } from '../providers/gemini'
import { frameBuffer } from '../footage/scan'
import { parseYouTubeUrl, readVideoFile, readYouTube, VideoError, youtubeCard } from './video'

export type VideoReadRequest = { kind: 'youtube'; url: string } | { kind: 'file'; path?: string }
export type VideoReadResult = { ok: true; brief: VideoBrief; thumb: string; name: string } | { ok: false; error: string; cancelled?: boolean }

export type InspectResult = { ok: true; item: InspectedRef } | { ok: false; name: string; error: string }

/** Reference pictures: pick or drop files, get back a chip with a thumbnail and a suggested role. Nothing is copied or sent yet. */
export function registerReferenceIpc(): void {
  /** read a reference video: a link is read by the AI (never downloaded), a file is measured on this computer */
  ipcMain.handle('refs:readVideo', async (e, req: VideoReadRequest): Promise<VideoReadResult> => {
    try {
      if (req?.kind === 'youtube') {
        const ref = parseYouTubeUrl(String(req.url ?? ''))
        if (!ref) return { ok: false, error: "That does not look like a YouTube link. Paste the video's address, for example https://www.youtube.com/watch?v=…" }
        if (!providerRegistry.hasKey('gemini')) return { ok: false, error: 'Reading a YouTube link needs a Google Gemini account connected in Settings. You can use a video file instead: it is read on this computer, with no AI.' }
        const card = await youtubeCard(ref)
        const brief = await readYouTube(providerRegistry.get('gemini') as unknown as GeminiProvider, ref, card)
        return { ok: true, brief, thumb: card.thumb, name: card.title || ref.url }
      }
      let path = typeof req?.path === 'string' ? req.path : ''
      if (!path) {
        const win = BrowserWindow.fromWebContents(e.sender)
        const pick = await dialog.showOpenDialog(win!, {
          title: 'Choose a video to learn from',
          properties: ['openFile'],
          filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS.map((x) => x.slice(1)) }]
        })
        if (pick.canceled || !pick.filePaths[0]) return { ok: false, error: '', cancelled: true }
        path = pick.filePaths[0]
      }
      const brief = await readVideoFile(path)
      const frame = await frameBuffer(path, Math.min(5, Math.max(0.5, brief.durationSec * 0.1)), 240)
      return { ok: true, brief, thumb: frame ? `data:image/jpeg;base64,${frame.toString('base64')}` : '', name: brief.title }
    } catch (err) {
      if (err instanceof VideoError) return { ok: false, error: err.message }
      const text = err instanceof Error ? err.message : String(err)
      // keep provider noise out of the sentence the person reads
      return { ok: false, error: /quota|billing|insufficient|429/i.test(text) ? 'The AI account refused this request (quota or billing). Check the account in Settings.' : /private|unavailable|not (?:found|accessible)|permission|403|404|400/i.test(text) ? 'The AI could not open that video. It must be public (not private, age-restricted or live). Try a video file instead.' : 'The video could not be read just now. Try again, or use a video file instead.' }
    }
  })

  ipcMain.handle('refs:inspect', async (e, paths?: string[]): Promise<InspectResult[]> => {
    let files = Array.isArray(paths) ? paths.map(String) : []
    if (!files.length) {
      const win = BrowserWindow.fromWebContents(e.sender)
      const pick = await dialog.showOpenDialog(win!, {
        title: 'Add pictures to this video',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
      })
      if (pick.canceled) return []
      files = pick.filePaths
    }
    const out: InspectResult[] = []
    for (const path of files.slice(0, 12)) {
      try {
        out.push({ ok: true, item: await inspectRef(path) })
      } catch (err) {
        out.push({ ok: false, name: path.split(/[\\/]/).pop() ?? path, error: err instanceof RefError ? err.message : 'This file could not be read as a picture.' })
      }
    }
    return out
  })
}
