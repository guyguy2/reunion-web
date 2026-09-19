import { faceUrl, type Person, type Scene, type Tag } from './api.ts'

/** Class photos people were tagged on. The generated portrait wall is left out: it is made from the profiles themselves. */
function classPhotos(scenes: Scene[]): Scene[] {
  return scenes.filter((s) => s.kind === 'group').reverse()
}

/** The picture on someone's yearbook tile: their own 90s photo, else their face on the newest class photo, else today's photo. */
export function tilePhoto(person: Person, scenes: Scene[]): string | null {
  if (person.thenPhoto) return person.thenPhoto
  for (const scene of classPhotos(scenes)) {
    const tag = scene.tags.find((t) => t.personId === person.id)
    if (tag) return faceUrl(tag)
  }
  return person.nowPhoto
}

/** Faces on the class photos that nobody has named yet, newest photo first. */
export function unknownFaces(scenes: Scene[]): Tag[] {
  return classPhotos(scenes).flatMap((s) => s.tags.filter((t) => t.personId == null))
}
