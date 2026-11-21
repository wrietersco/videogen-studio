/**
 * The place a finished video is going to be posted, and how its description should read there.
 * The person picks one (or types any other); the description is written for that place.
 */
export interface DescribePlatform {
  id: string
  label: string
  emoji: string
  /** the most characters the description can hold there */
  limit: number
  /** how a good description reads on that platform, told to the writer */
  style: string
  /** a title is asked for (YouTube, Pinterest, a blog) */
  title: boolean
  /** roughly how many hashtags suit it (0 = none) */
  hashtags: number
}

export const DESCRIBE_PLATFORMS: DescribePlatform[] = [
  { id: 'youtube', label: 'YouTube', emoji: '📺', limit: 5000, title: true, hashtags: 3, style: 'A searchable title under 70 characters with the main keyword first. A description whose first two lines hook the viewer (they show before "more"), then a short paragraph on what the video covers, a call to action, and 3 hashtags at the end.' },
  { id: 'youtube-shorts', label: 'YouTube Shorts', emoji: '▶️', limit: 100, title: false, hashtags: 3, style: 'One punchy caption of at most 100 characters in all, including the hashtags: #Shorts and two topic hashtags.' },
  { id: 'tiktok', label: 'TikTok', emoji: '🎵', limit: 2200, title: false, hashtags: 5, style: 'A short, casual, hook-first caption (one to three short lines) with a question or a bold claim, a light call to action, and 4 to 5 trending-style hashtags. Emoji welcome.' },
  { id: 'instagram-reels', label: 'Instagram Reels', emoji: '📸', limit: 2200, title: false, hashtags: 5, style: 'A hook line first, two or three short lines of value, a call to action (save, share, follow, link in bio) and 5 relevant hashtags at the end. Friendly, a few emoji.' },
  { id: 'instagram-feed', label: 'Instagram post', emoji: '🖼️', limit: 2200, title: false, hashtags: 8, style: 'A strong first line (it shows before "more"), a short story or benefit list with line breaks, a call to action, then 6 to 8 hashtags separated from the text.' },
  { id: 'facebook', label: 'Facebook', emoji: '👍', limit: 63206, title: false, hashtags: 2, style: 'Conversational and warm, two short paragraphs, ending with a question that invites comments and a link prompt. At most 2 hashtags.' },
  { id: 'linkedin', label: 'LinkedIn', emoji: '💼', limit: 3000, title: false, hashtags: 4, style: 'Professional but human. A one-line hook, short paragraphs with white space, the insight or result, a question to start discussion, and 3 to 4 hashtags at the end. No emoji spam.' },
  { id: 'x', label: 'X (Twitter)', emoji: '🐦', limit: 280, title: false, hashtags: 2, style: 'One sharp post of at most 280 characters including hashtags and the space for a link (keep it to about 250). A hook, the point, at most 2 hashtags.' },
  { id: 'threads', label: 'Threads', emoji: '🧵', limit: 500, title: false, hashtags: 1, style: 'Conversational, one to three short lines, a question to invite replies, at most one hashtag.' },
  { id: 'pinterest', label: 'Pinterest', emoji: '📌', limit: 500, title: true, hashtags: 3, style: 'A keyword-rich title under 100 characters and a description that says plainly what the viewer will learn or get, with natural search phrases, then 3 hashtags.' },
  { id: 'snapchat', label: 'Snapchat Spotlight', emoji: '👻', limit: 250, title: false, hashtags: 3, style: 'A very short, playful caption, with 2 to 3 hashtags.' },
  { id: 'whatsapp', label: 'WhatsApp / Telegram', emoji: '💬', limit: 1000, title: false, hashtags: 0, style: 'A short friendly message a person would forward: what it is, why to watch, one line to act. No hashtags.' },
  { id: 'reddit', label: 'Reddit', emoji: '👽', limit: 300, title: true, hashtags: 0, style: 'A plain, honest title that states what the video shows, no hype, no hashtags; a one-paragraph description that adds context and invites feedback.' },
  { id: 'website', label: 'Website / blog', emoji: '🌐', limit: 1000, title: true, hashtags: 0, style: 'A clear page title and a two-to-three sentence summary that can sit beside the embedded video (and serve as its meta description).' },
  { id: 'email', label: 'Email', emoji: '✉️', limit: 600, title: true, hashtags: 0, style: 'A subject line under 60 characters and a short body (three or four sentences) that introduces the video and ends with one clear call to action.' }
]

/** what the writer is told about a place the list does not know (the person typed its name) */
export const customPlatform = (name: string): DescribePlatform => ({
  id: 'custom', label: name.trim().slice(0, 40) || 'Other', emoji: '✨', limit: 2000, title: true, hashtags: 3,
  style: `Follow the usual conventions of ${name.trim().slice(0, 40) || 'that platform'}: its tone, its length and how people there write about a video. If it uses hashtags, add a few.`
})

export interface VideoDescription {
  platform: string
  title?: string
  description: string
  hashtags: string[]
  /** everything above as one block, ready to paste */
  text: string
  /** written by the AI writer, or put together from the video's own words when no writer was available */
  source: 'ai' | 'rules'
  /** short notes for the person (the writer was unavailable, the text was shortened to fit) */
  notes: string[]
}
