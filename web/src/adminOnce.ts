/**
 * Runs actions one at a time: a call while another is still running is ignored, so a double click or a double key
 * press can't answer twice or create two profiles. `onBusy` hears when an action starts and ends.
 */
export function oneAtATime(onBusy: (busy: boolean) => void): (action: () => Promise<unknown>) => Promise<void> {
  let running = false
  return async (action) => {
    if (running) return
    running = true
    onBusy(true)
    try {
      await action()
    } finally {
      running = false
      onBusy(false)
    }
  }
}
