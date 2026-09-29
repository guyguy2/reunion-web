/** Whether a key press lands where someone is typing (a field, a dropdown, editable text), so letter shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as Element | null
  return typeof element?.closest === 'function' && element.closest('input, textarea, select, [contenteditable]') !== null
}
