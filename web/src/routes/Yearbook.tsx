import { lazy, useSyncExternalStore } from 'react'
import YearbookGrid from './YearbookGrid.tsx'

// Loaded only on bigger screens, so phones never download the zoom viewer or the big class photos.
const YearbookViewer = lazy(() => import('./YearbookViewer.tsx'))

/** Phones: narrow screens, or a phone turned sideways (touch and short). */
export const PHONE_QUERY = '(max-width: 767px), (pointer: coarse) and (max-height: 500px)'

function subscribe(onChange: () => void) {
  const query = window.matchMedia(PHONE_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** The grid on phones, the big zoomable class photos everywhere else. */
export default function Yearbook() {
  const isPhone = useSyncExternalStore(subscribe, () => window.matchMedia(PHONE_QUERY).matches)
  return isPhone ? <YearbookGrid /> : <YearbookViewer />
}
