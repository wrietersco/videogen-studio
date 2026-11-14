/** A public YouTube link, reduced to its canonical form. Shared so the screen and the main process agree on what a link is. */
export interface YouTubeRef {
  id: string
  /** the canonical link, the only form ever sent anywhere */
  url: string
}

export function parseYouTubeUrl(text: string): YouTubeRef | null {
  let u: URL
  try {
    u = new URL(String(text ?? '').trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.replace(/^www\.|^m\./, '').toLowerCase()
  let id = ''
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0]
  else if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v') ?? ''
    else {
      const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname)
      if (m) id = m[1]
    }
  }
  if (!/^[\w-]{11}$/.test(id)) return null
  return { id, url: `https://www.youtube.com/watch?v=${id}` }
}

export const MAX_STYLE_LINKS = 3
