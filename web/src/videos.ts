import type { Video } from './api.ts'

export const PROVIDER_NAME: Record<Video['provider'], string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X',
  gphotos: 'Google Photos',
}

const GPHOTOS = 'https://lh3.googleusercontent.com/pw/'

/** Album videos play in our own player: 720p when Google made one, else the 360p copy every video has. */
export function streamUrls(video: Pick<Video, 'externalId'>): string[] {
  return ['m22', 'm18'].map((size) => `${GPHOTOS}${video.externalId}=${size}`)
}

/** The player to load on click. Built from the validated ID, never from the pasted link. */
export function embedUrl(video: Pick<Video, 'provider' | 'externalId' | 'url'>): string {
  const id = encodeURIComponent(video.externalId)
  switch (video.provider) {
    case 'instagram':
      return `https://www.instagram.com/p/${id}/embed/`
    case 'facebook':
      return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(video.url)}&show_text=false&autoplay=true`
    case 'x':
      return `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true&lang=he`
    default:
      return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`
  }
}

/** Only YouTube and album videos have a thumbnail we can show without loading a player. */
export function thumbnailUrl(video: Pick<Video, 'provider' | 'externalId'>): string | null {
  if (video.provider === 'gphotos') return `${GPHOTOS}${video.externalId}=w960`
  return video.provider === 'youtube' ? `https://i.ytimg.com/vi/${encodeURIComponent(video.externalId)}/hqdefault.jpg` : null
}

/** Instagram and X embeds are tall posts with the video inside; YouTube and Facebook are plain players. */
export function isTallEmbed(provider: Video['provider']): boolean {
  return provider === 'instagram' || provider === 'x'
}
