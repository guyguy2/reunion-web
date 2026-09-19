import type { Person } from '../api.ts'

type Links = Pick<Person, 'email' | 'instagram' | 'linkedin' | 'facebook' | 'website' | 'phone' | 'x'>

/** The site's name, so a link reads "tiktok.com" rather than just "website". */
function siteName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'אתר'
  }
}

/** Email, phone, Instagram, LinkedIn, Facebook, X and website buttons. Shows the real address and handle, not just a label. */
export default function ContactLinks({ person }: { person: Links }) {
  if (!person.email && !person.instagram && !person.linkedin && !person.facebook && !person.website && !person.phone && !person.x) return null
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {person.email && (
        <a className="btn btn-plain btn-sm break-all" href={`mailto:${person.email}`} dir="ltr" aria-label={`אימייל: ${person.email}`}>
          {person.email}
        </a>
      )}
      {person.phone && (
        <a className="btn btn-plain btn-sm" href={`tel:${person.phone.replace(/[^\d+]/g, '')}`} dir="ltr" aria-label={`טלפון: ${person.phone}`}>
          {person.phone}
        </a>
      )}
      {person.instagram && (
        <a className="btn btn-pink btn-sm" href={`https://instagram.com/${person.instagram}`} target="_blank" rel="noreferrer">
          @{person.instagram}
        </a>
      )}
      {person.linkedin && (
        <a className="btn btn-teal btn-sm" href={person.linkedin} target="_blank" rel="noreferrer">
          LinkedIn
        </a>
      )}
      {person.facebook && (
        <a className="btn btn-sm bg-sky" href={person.facebook} target="_blank" rel="noreferrer">
          Facebook
        </a>
      )}
      {person.x && (
        <a className="btn btn-sm bg-ink text-white" href={`https://x.com/${person.x}`} target="_blank" rel="noreferrer" dir="ltr">
          @{person.x}
        </a>
      )}
      {person.website && (
        <a className="btn btn-plain btn-sm" href={person.website} target="_blank" rel="noreferrer" dir="ltr">
          {siteName(person.website)}
        </a>
      )}
    </div>
  )
}
