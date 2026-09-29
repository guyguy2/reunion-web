/**
 * Whole calendar days from `now` to `when`, in local time: 0 on the day itself, 1 the day before, negative once it
 * has passed. Counting dates rather than 24-hour stretches, so the evening before an evening event is still "tomorrow".
 */
export function daysUntil(when: Date, now: Date): number {
  // Each local date as midnight UTC, so a daylight saving change in between can't shift the count.
  const date = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((date(when) - date(now)) / 86_400_000)
}
