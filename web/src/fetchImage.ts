/** Downloads a picture. An error answer fails here, in Hebrew, instead of being handed on to be decoded as an image. */
export async function fetchImageBlob(url: string): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new Error('לא הצלחנו להוריד את התמונה. נסו שוב.')
  return res.blob()
}
