import { describe, expect, it, vi } from 'vitest'
import { isTypingTarget } from '../web/src/adminKeys.ts'
import { oneAtATime } from '../web/src/adminOnce.ts'
import { nextLive, previousLive } from '../web/src/adminQueue.ts'

// The tests run without a DOM, so this stands in for an element: `closest` walks up the parents like the browser's,
// matching tag names, [attribute] and [attribute="value"] selectors and :not(), and like the browser's it fails when
// called without its element.
interface FakeElement {
  tagName: string
  attributes: Record<string, string>
  parentElement: FakeElement | null
  closest(selector: string): FakeElement | null
}

function element(tagName: string, attributes: Record<string, string> = {}, parentElement: FakeElement | null = null): FakeElement {
  return {
    tagName: tagName.toUpperCase(),
    attributes,
    parentElement,
    closest(this: FakeElement | undefined, selector: string) {
      if (!this) throw new TypeError('Illegal invocation')
      const parts = selector.split(',').map((part) => part.trim())
      for (let node: FakeElement | null = this; node; node = node.parentElement) {
        const current = node
        if (parts.some((part) => matches(current, part))) return current
      }
      return null
    },
  }
}

function matches(node: FakeElement, part: string): boolean {
  const not = /^(.+):not\((.+)\)$/.exec(part)
  if (not) return matches(node, not[1]) && !matches(node, not[2])
  const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part)
  if (attribute) return attribute[1] in node.attributes && (attribute[2] === undefined || node.attributes[attribute[1]] === attribute[2])
  return node.tagName === part.toUpperCase()
}

const typing = (target: FakeElement | object | null) => isTypingTarget(target as EventTarget | null)

describe('roster keyboard shortcuts', () => {
  it('stay out of text fields, text areas and dropdowns', () => {
    expect(typing(element('input'))).toBe(true)
    expect(typing(element('textarea'))).toBe(true)
    expect(typing(element('select'))).toBe(true)
  })

  it('stay out of editable text, including the spans inside it', () => {
    const editor = element('div', { contenteditable: 'true' })
    expect(typing(editor)).toBe(true)
    expect(typing(element('span', {}, element('span', {}, editor)))).toBe(true)
  })

  it('still work on text marked as not editable', () => {
    expect(typing(element('div', { contenteditable: 'false' }))).toBe(false)
    expect(typing(element('span', {}, element('div', { contenteditable: 'false' })))).toBe(false)
  })

  it('still work on buttons, plain text and the page itself', () => {
    expect(typing(element('button'))).toBe(false)
    expect(typing(element('span', {}, element('span', {}, element('div'))))).toBe(false)
    expect(typing(element('body'))).toBe(false)
  })

  it('still work when there is no element to check', () => {
    expect(typing(null)).toBe(false)
    // The window receives key presses too, and it has no `closest`.
    expect(typing({ addEventListener() {} })).toBe(false)
  })
})

describe('roster review queue', () => {
  // People 2 and 4 were merged into someone else or hidden as staff after the queue was frozen.
  const queue = [1, 2, 3, 4, 5]
  const exists = (id: number) => id !== 2 && id !== 4

  it('stays on a person who is still there', () => {
    expect(nextLive(queue, 0, exists)).toBe(0)
    expect(nextLive(queue, 2, exists)).toBe(2)
  })

  it('steps over people who are gone', () => {
    expect(nextLive(queue, 1, exists)).toBe(2)
    expect(nextLive(queue, 3, exists)).toBe(4)
  })

  it('runs off the end when nobody is left', () => {
    expect(nextLive(queue, 5, exists)).toBe(5)
    expect(nextLive([1, 2], 0, () => false)).toBe(2)
  })

  it('goes back past people who are gone instead of landing on nobody', () => {
    expect(previousLive(queue, 2, exists)).toBe(0)
    expect(previousLive(queue, 4, exists)).toBe(2)
  })

  it('has nowhere to go back to at the start', () => {
    expect(previousLive(queue, 0, exists)).toBe(-1)
    expect(previousLive([2, 3], 1, (id) => id === 3)).toBe(-1)
  })

  it('goes back from the end of the queue to the last person still there', () => {
    expect(previousLive(queue, queue.length, (id) => id !== 5)).toBe(3)
  })

  it('moves on after hiding the current person, without skipping the next one', () => {
    // Person 3 is hidden as staff while on screen; advancing from their place shows person 5, the next still there.
    const afterStaff = (id: number) => exists(id) && id !== 3
    const at = 2
    expect(nextLive(queue, at + 1, afterStaff)).toBe(4)
    expect(queue[nextLive(queue, at, afterStaff)]).toBe(5)
  })
})

describe('one roster action at a time', () => {
  it('ignores a second call while the first is still running', async () => {
    let finish = () => {}
    const busy = vi.fn()
    const once = oneAtATime(busy)
    const first = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const second = vi.fn(async () => {})

    const running = once(first)
    await once(second)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(busy).toHaveBeenLastCalledWith(true)

    finish()
    await running
    expect(busy).toHaveBeenLastCalledWith(false)
    await once(second)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('lets the next call run after one fails', async () => {
    const busy = vi.fn()
    const once = oneAtATime(busy)
    await expect(once(() => Promise.reject(new Error('network down')))).rejects.toThrow('network down')
    expect(busy).toHaveBeenLastCalledWith(false)

    const next = vi.fn(async () => {})
    await once(next)
    expect(next).toHaveBeenCalledTimes(1)
  })
})
