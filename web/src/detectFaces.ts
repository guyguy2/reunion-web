import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'

// The model wants faces that fill a good part of its input, and class posters have hundreds of tiny ones.
// So we slide small windows over the full image at a few sizes and merge the results.
const WINDOWS = [180, 300, 480]
const OVERLAP = 0.45

/** Lets the page repaint between batches. A message channel is used because browsers throttle timers in background tabs. */
function breathe(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => resolve()
    channel.port2.postMessage(null)
  })
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  // Relative to the smaller box, so a face found at two window sizes still counts as one.
  return (w * h) / Math.min(a.w * a.h, b.w * b.h)
}

export async function detectFaces(imageUrl: string, existing: Box[], onProgress: (fraction: number) => void): Promise<Box[]> {
  const vision = await FilesetResolver.forVisionTasks(WASM)
  const detector = await FaceDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL },
    runningMode: 'IMAGE',
    minDetectionConfidence: 0.6,
  })
  // createImageBitmap decodes off the main thread and, unlike <img>.decode(), also works in a background tab.
  const image = await createImageBitmap(await (await fetch(imageUrl)).blob())

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const found: (Box & { score: number })[] = []
  const total = WINDOWS.reduce((sum, size) => {
    const step = size * (1 - OVERLAP)
    return sum + Math.ceil(image.width / step) * Math.ceil(image.height / step)
  }, 0)
  let done = 0

  for (const size of WINDOWS) {
    const step = Math.round(size * (1 - OVERLAP))
    canvas.width = canvas.height = 256
    const scale = size / 256
    for (let top = 0; top < image.height; top += step) {
      for (let left = 0; left < image.width; left += step) {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, 256, 256)
        ctx.drawImage(image, left, top, size, size, 0, 0, 256, 256)
        for (const detection of detector.detect(canvas).detections) {
          const box = detection.boundingBox
          if (!box) continue
          const w = box.width * scale
          const h = box.height * scale
          // Skip faces cut off by the window edge; a neighboring window sees them whole.
          if (box.originX < 2 || box.originY < 2 || box.originX + box.width > 254 || box.originY + box.height > 254) continue
          found.push({ x: left + box.originX * scale, y: top + box.originY * scale, w, h, score: detection.categories[0]?.score ?? 0 })
        }
        if (++done % 25 === 0) {
          onProgress(done / total)
          await breathe()
        }
      }
    }
  }
  detector.close()
  image.close()

  const kept: Box[] = []
  for (const candidate of found.sort((a, b) => b.score - a.score)) {
    if ([...kept, ...existing].some((box) => overlap(box, candidate) > 0.35)) continue
    kept.push(candidate)
  }
  // Detections hug the face; grow them to include hair and chin so the crop looks like a portrait.
  return kept.map(({ x, y, w, h }) => ({
    x: Math.max(0, x - w * 0.12),
    y: Math.max(0, y - h * 0.32),
    w: w * 1.24,
    h: h * 1.5,
  }))
}
