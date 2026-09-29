import sharp from 'sharp'
import { expect, login, test } from './fixtures.ts'
import type { Locator, Page } from '@playwright/test'

// The class photo viewer, the person panel and the friends grid, on the demo data: 60 invented people, the portrait
// wall, and one group photo with 48 faces (42 named, 6 not). Tests that change the data (naming faces, adding dated
// posters) come last, because the tests of one file share one server in order.

interface Tag {
  id: number
  personId: number | null
  x: number
  y: number
  w: number
  h: number
}
interface Scene {
  id: number
  slug: string
  title: string
  kind: 'group' | 'mosaic'
  width: number
  height: number
  tags: Tag[]
}
interface Person {
  id: number
  name: string
  email: string | null
  instagram: string | null
  city: string | null
  bio: string | null
  quote: string | null
  nowPhoto: string | null
  thenPhoto: string | null
  attending: 'yes' | 'maybe' | 'no' | null
  claimed: boolean
}

const ATTENDING = { yes: 'אהיה שם!', maybe: 'אולי...', no: 'לא אוכל להגיע' }
const UNKNOWN = 'מי בתמונה?'

/** What the site itself would load, read through the API so nothing is hard-coded. Needs a logged-in page. */
async function demo(page: Page) {
  const people: Person[] = await (await page.request.get('/api/people')).json()
  const scenes: Scene[] = await (await page.request.get('/api/scenes')).json()
  const group = scenes.find((s) => s.kind === 'group')!
  const wall = scenes.find((s) => s.kind === 'mosaic')!
  const byId = new Map(people.map((p) => [p.id, p]))
  const nameCount = new Map<string, number>()
  for (const p of people) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1)
  const inGroup = new Set(group.tags.map((t) => t.personId))
  // Faces near the middle of the photo are away from the toolbar, the side panel and the zoom buttons.
  const middle = (t: Tag) => Math.hypot(t.x + t.w / 2 - group.width / 2, t.y + t.h / 2 - group.height / 2)
  const named = group.tags
    .filter((t) => t.personId != null && nameCount.get(byId.get(t.personId!)!.name) === 1)
    .sort((a, b) => middle(a) - middle(b))
    .map((t) => ({ tag: t, person: byId.get(t.personId!)! }))
  const unknown = group.tags.filter((t) => t.personId == null).sort((a, b) => middle(a) - middle(b))
  return {
    people,
    scenes,
    group,
    wall,
    byId,
    /** Someone with a filled-in profile (contact links, city, bio, RSVP, then and now photos) who is on the class photo. */
    full: named.find(({ person: p }) => p.email && p.instagram && p.city && p.bio && p.attending && p.nowPhoto && p.thenPhoto && p.claimed)!.person,
    /** Someone with only the basics, also on the class photo. */
    plain: named.filter(({ person: p }) => !p.email && !p.nowPhoto && !p.claimed).map(({ person }) => person),
    /** People who are on the portrait wall but not on the class photo. */
    wallOnly: people.filter((p) => !inGroup.has(p.id) && nameCount.get(p.name) === 1),
    /** The unknown faces, nearest to the middle first. */
    unknown,
    /** Where a face sits among the unknown ones, which is where it sits among the "מי בתמונה?" overlays. */
    unknownRank: (tag: Tag) => group.tags.filter((t) => t.personId == null).indexOf(tag),
  }
}

const face = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const closeButton = (page: Page) => page.getByRole('button', { name: 'סגירה' })
/** The desktop panel is a bare section (no dialog role), found by its name heading. */
const panelOf = (page: Page, name: string) => page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name, exact: true }) })
const yearbookSlug = /senior-class-photo-/

/** Opens the class photo and waits until its face overlays are on it. */
async function openViewer(page: Page, url = '/', waitFor?: string) {
  await page.goto(url)
  await expect(face(page, waitFor ?? UNKNOWN).first()).toBeVisible()
}

async function focusedFace(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement
    return el?.classList.contains('face-tag') ? el.getAttribute('aria-label') : null
  })
}

/** Tabs from the top of the page until a face has focus. Only one face is in the tab order. */
async function tabToFace(page: Page): Promise<string> {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab')
    const name = await focusedFace(page)
    if (name) return name
  }
  throw new Error('Tab never reached a face')
}

const width = async (el: Locator) => (await el.boundingBox())!.width

test.describe('class photo viewer', () => {
  test('shows the group photo with its faces, then the portrait wall, and back', async ({ page }) => {
    await login(page, 'member')
    const { group, wall } = await demo(page)
    await openViewer(page)

    await expect(page.getByText('42/48 זוהו')).toBeVisible()
    await expect(page.locator('.face-tag')).toHaveCount(group.tags.length)
    await expect(face(page, UNKNOWN)).toHaveCount(6)
    // The group photo is on screen and its button is the lit one; the wall button is beside it.
    await expect(page.getByRole('button', { name: group.title })).toBeVisible()

    await page.getByRole('button', { name: wall.title }).click()
    await expect(page).toHaveURL(/\?s=wall$/)
    // The wall is made of everyone's portrait, so every face has a name and the "identified" counter is not shown.
    await expect(page.locator('.face-tag')).toHaveCount(wall.tags.length)
    await expect(face(page, UNKNOWN)).toHaveCount(0)
    await expect(page.getByText(/זוהו/)).toHaveCount(0)

    await page.getByRole('button', { name: group.title }).click()
    await expect(page).toHaveURL(new RegExp(`\\?s=${group.slug}$`))
    await expect(page.getByText('42/48 זוהו')).toBeVisible()
    await expect(face(page, UNKNOWN)).toHaveCount(6)
  })

  test('zooms in, out, and back to the whole photo, with the buttons and with Escape', async ({ page }) => {
    await login(page, 'member')
    const { plain } = await demo(page)
    await openViewer(page)
    const target = face(page, plain[0].name)
    const whole = await width(target)

    await page.getByRole('button', { name: 'הגדלה' }).click()
    await expect.poll(() => width(target)).toBeGreaterThan(whole * 1.5)
    await page.getByRole('button', { name: 'הגדלה' }).click()
    await expect.poll(() => width(target)).toBeGreaterThan(whole * 2.4)

    await page.getByRole('button', { name: 'הקטנה' }).click()
    await expect.poll(() => width(target)).toBeLessThan(whole * 2.4)
    await expect.poll(() => width(target)).toBeGreaterThan(whole * 1.4)

    await page.getByRole('button', { name: 'הצגת התמונה כולה' }).click()
    await expect.poll(() => width(target)).toBeCloseTo(whole, 0)

    // Escape does what "show the whole photo" does when no window is open.
    await page.getByRole('button', { name: 'הגדלה' }).click()
    await expect.poll(() => width(target)).toBeGreaterThan(whole * 1.5)
    await page.keyboard.press('Escape')
    await expect.poll(() => width(target)).toBeCloseTo(whole, 0)
  })

  test('the hover bubble on a named face offers the profile, and on an unknown face offers to add a name', async ({ page }) => {
    await login(page, 'member')
    const { plain, unknown, unknownRank } = await demo(page)
    await openViewer(page)

    const named = face(page, plain[0].name)
    await named.hover()
    await expect(named.getByText('לחצו לצפייה בפרופיל')).toBeVisible()
    const stranger = face(page, UNKNOWN).nth(unknownRank(unknown[0]))
    await stranger.hover()
    await expect(stranger.getByText('לחצו להוספת שם')).toBeVisible()
  })
})

test.describe('named faces and the person panel', () => {
  test('a click opens the panel and /p/:id; it closes with X, Escape and browser back, and the viewer still works', async ({ page }) => {
    await login(page, 'member')
    const { plain } = await demo(page)
    const [a, b] = plain
    await openViewer(page)

    await face(page, a.name).click()
    await expect(page).toHaveURL(new RegExp(`/p/${a.id}\\?s=${yearbookSlug.source}`))
    await expect(panelOf(page, a.name)).toBeVisible()
    await expect(panelOf(page, a.name).getByText(a.quote!)).toBeVisible()

    await closeButton(page).click()
    await expect(closeButton(page)).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/\\?s=${yearbookSlug.source}`))

    // Still usable: another face opens its own panel, and Escape closes that one.
    await face(page, b.name).click()
    await expect(panelOf(page, b.name)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/p/${b.id}\\?`))
    await page.keyboard.press('Escape')
    await expect(closeButton(page)).toHaveCount(0)
    await expect(page).not.toHaveURL(/\/p\//)

    // Browser back leaves the profile the same way.
    await face(page, a.name).click()
    await expect(panelOf(page, a.name)).toBeVisible()
    await page.goBack()
    await expect(closeButton(page)).toHaveCount(0)
    await expect(page).not.toHaveURL(/\/p\//)
    await expect(face(page, UNKNOWN)).toHaveCount(6)
  })

  test('a filled-in profile shows contact links, RSVP, bio, then and now, and the class photo it is on', async ({ page }) => {
    await login(page, 'member')
    const { full, group } = await demo(page)
    await openViewer(page, '/')
    await face(page, full.name).click()
    const panel = panelOf(page, full.name)
    await expect(panel).toBeVisible()

    await expect(panel.getByText(full.city!)).toBeVisible()
    await expect(panel.getByText(full.bio!)).toBeVisible()
    await expect(panel.getByText(full.quote!)).toBeVisible()
    await expect(panel.getByText(ATTENDING[full.attending!])).toBeVisible()
    await expect(panel.getByRole('link', { name: `אימייל: ${full.email}` })).toHaveAttribute('href', `mailto:${full.email}`)
    await expect(panel.getByRole('link', { name: `@${full.instagram}` })).toHaveAttribute('href', `https://instagram.com/${full.instagram}`)
    await expect(panel.getByRole('heading', { name: 'אז / היום' })).toBeVisible()
    await expect(panel.getByRole('img', { name: 'אז' })).toBeVisible()
    await expect(panel.getByRole('img', { name: 'היום' })).toBeVisible()
    await expect(panel.getByRole('heading', { name: 'לאורך השנים' })).toBeVisible()
    await expect(panel.getByRole('button', { name: group.title })).toBeVisible()
    // Claimed by someone else, so the way in is the personal code; anyone can write a note.
    await expect(panel.getByRole('button', { name: 'זה הפרופיל שלי. כניסה עם הקוד האישי' })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'שליחת פתק' })).toBeVisible()

    // A photo opens bigger over the panel; Escape closes only the photo.
    await panel.getByRole('button', { name: 'הגדלת התמונה' }).click()
    const enlarged = page.getByRole('dialog', { name: 'צפייה בתמונה' })
    await expect(enlarged).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(enlarged).toHaveCount(0)
    await expect(panel).toBeVisible()
  })

  test('a basic profile has no contact links or slider and invites its owner to claim it', async ({ page }) => {
    await login(page, 'member')
    const { plain } = await demo(page)
    const person = plain[0]
    await openViewer(page, `/p/${person.id}`, person.name)
    const panel = panelOf(page, person.name)
    await expect(panel).toBeVisible()

    await expect(panel.getByText(person.quote!)).toBeVisible()
    await expect(panel.getByRole('link')).toHaveCount(0)
    await expect(panel.getByRole('heading', { name: 'אז / היום' })).toHaveCount(0)
    await expect(panel.getByText('אף אחד עדיין לא לקח בעלות על הפרופיל הזה.')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'זה הפרופיל שלי! אני רוצה לערוך אותו' })).toBeVisible()
  })

  test('the class photos in a panel jump between scenes and keep the profile open', async ({ page }) => {
    await login(page, 'member')
    const { full, group } = await demo(page)
    await openViewer(page, `/p/${full.id}?s=wall`, full.name)
    await expect(page.getByText(/זוהו/)).toHaveCount(0)
    const panel = panelOf(page, full.name)

    await panel.getByRole('button', { name: group.title }).click()
    await expect(page).toHaveURL(new RegExp(`/p/${full.id}\\?s=${group.slug}$`))
    await expect(page.getByText('42/48 זוהו')).toBeVisible()
    await expect(panel).toBeVisible()
  })
})

test.describe('deep links', () => {
  test('/p/:id in a fresh page opens that person on the class photo', async ({ page }) => {
    await login(page, 'member')
    const { plain } = await demo(page)
    const person = plain[1]
    await openViewer(page, `/p/${person.id}`, person.name)

    await expect(panelOf(page, person.name)).toBeVisible()
    await expect(page.getByText('42/48 זוהו')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/p/${person.id}$`))
  })

  test('a person who is only on the portrait wall moves the page to the wall, and back leaves the page', async ({ page }) => {
    await login(page, 'member')
    const { wallOnly } = await demo(page)
    const person = wallOnly[0]
    await page.goto('/')
    await page.goto(`/p/${person.id}`)

    await expect(panelOf(page, person.name)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/p/${person.id}\\?s=wall$`))
    await expect(page.getByText(/זוהו/)).toHaveCount(0)
    await expect(face(page, person.name)).toBeVisible()

    // The move replaced the link in the history, so back does not bounce forward again.
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    await expect(closeButton(page)).toHaveCount(0)
  })

  for (const bad of ['999999', 'nobody']) {
    test(`/p/${bad} does not crash: no panel, the class photo is still there`, async ({ page }) => {
      await login(page, 'member')
      await openViewer(page, `/p/${bad}`)
      await expect(closeButton(page)).toHaveCount(0)
      await expect(page.getByText('42/48 זוהו')).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`/p/${bad}$`))
    })
  }
})

test.describe('keyboard', () => {
  test('Tab enters the faces, arrows move between them, Enter opens the panel and Escape closes it', async ({ page }) => {
    await login(page, 'member')
    const { group, byId } = await demo(page)
    const nameAt = (i: number) => byId.get(group.tags[i].personId!)!.name
    await openViewer(page)
    await page.mouse.click(1, 1)

    // The one face in the tab order is the right end of the top row, where a Hebrew reader starts.
    const entry = await tabToFace(page)
    expect(entry).toBe(nameAt(11))
    await page.keyboard.press('ArrowLeft')
    expect(await focusedFace(page)).toBe(nameAt(10))
    await page.keyboard.press('ArrowRight')
    expect(await focusedFace(page)).toBe(entry)
    await page.keyboard.press('ArrowDown')
    const below = await focusedFace(page)
    expect(below).not.toBe(entry)
    expect(below).not.toBeNull()
    await page.keyboard.press('ArrowUp')
    expect(await focusedFace(page)).toBe(entry)

    await page.keyboard.press('Enter')
    const person = [...byId.values()].find((p) => p.name === entry)!
    await expect(panelOf(page, entry)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/p/${person.id}\\?s=`))

    // Escape closes the panel and the same face keeps the focus; the next Tab leaves the faces.
    await page.keyboard.press('Escape')
    await expect(closeButton(page)).toHaveCount(0)
    expect(await focusedFace(page)).toBe(entry)
    await page.keyboard.press('Tab')
    expect(await focusedFace(page)).toBeNull()
  })

  test('Space on an unknown face opens the naming panel, and Escape closes it', async ({ page }) => {
    await login(page, 'member')
    await openViewer(page)
    await face(page, UNKNOWN).first().focus()
    await page.keyboard.press('Space')
    await expect(page.getByText('עדיין אין שם לתמונה הזו. עזרו למלא את ספר המחזור:')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText('עדיין אין שם לתמונה הזו. עזרו למלא את ספר המחזור:')).toHaveCount(0)
  })
})

test.describe('search in the viewer', () => {
  test('a name finds the person: pick from the list, or press Enter for the first', async ({ page }) => {
    await login(page, 'member')
    const { plain, people } = await demo(page)
    const [a, b] = plain
    await openViewer(page)
    const search = page.getByRole('searchbox', { name: 'חיפוש בוגרים לפי שם' })
    await expect(search).toHaveAttribute('placeholder', `חיפוש לפי שם (${people.length} עד כה)`)

    await search.fill(a.name)
    await page.getByRole('listitem').getByRole('button', { name: a.name }).click()
    await expect(panelOf(page, a.name)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/p/${a.id}\\?s=`))
    await expect(search).toHaveValue('')

    // Searching for somebody else moves the panel to them.
    await search.fill(b.name.toUpperCase())
    await search.press('Enter')
    await expect(panelOf(page, b.name)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/p/${b.id}\\?s=`))
  })

  test('someone who is only on the wall is found on the wall', async ({ page }) => {
    await login(page, 'member')
    const { wallOnly } = await demo(page)
    const person = wallOnly[0]
    await openViewer(page)
    const search = page.getByRole('searchbox', { name: 'חיפוש בוגרים לפי שם' })
    await search.fill(person.name)
    await search.press('Enter')

    await expect(panelOf(page, person.name)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/p/${person.id}\\?s=wall$`))
    await expect(page.getByText(/זוהו/)).toHaveCount(0)
  })

  test('a name nobody has shows the no-match message', async ({ page }) => {
    await login(page, 'member')
    await openViewer(page)
    await page.getByRole('searchbox', { name: 'חיפוש בוגרים לפי שם' }).fill('Qwertyuiop')
    await expect(page.getByText('עדיין אין מישהו בשם הזה. מצאו את התמונה והוסיפו שם!')).toBeVisible()
    await expect(page.getByRole('listitem').getByRole('button')).toHaveCount(0)
  })
})

test.describe('friends grid', () => {
  test('lists everyone, and a name search narrows it, in the address, across a reload and for another member', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const { people } = await demo(page)
    // Person tiles are the only buttons named with two Latin words, in the order the grid shows them.
    const tiles = (p: Page) => p.getByRole('button', { name: /^[A-Za-z]+ [A-Za-z]+$/ })
    await openViewer(page)
    await page.getByRole('link', { name: 'סינון לפי כיתה, שנה, בנים/בנות' }).click()
    await expect(page).toHaveURL(/\/friends$/)
    await expect(page.getByRole('heading', { name: 'חיפוש חברים' })).toBeVisible()

    // Sorted by name; the demo has no classes or years, so no class, year or sort menus and no gender chips yet.
    await expect(tiles(page)).toHaveCount(people.length)
    expect(await tiles(page).allTextContents()).toEqual(people.map((p) => p.name).sort((a, b) => a.localeCompare(b, 'he')))
    await expect(page.getByLabel('שנה')).toHaveCount(0)
    await expect(page.getByRole('group', { name: 'בנים או בנות' })).toHaveCount(0)

    const query = 'amanda'
    const matching = people.filter((p) => p.name.toLowerCase().includes(query))
    expect(matching.length).toBeGreaterThan(1)
    const search = page.getByRole('searchbox', { name: 'חיפוש בוגרים לפי שם' })
    await search.fill(query.toUpperCase())
    await expect(tiles(page)).toHaveCount(matching.length)
    await expect(page.getByRole('status')).toContainText(`${matching.length} מתוך ${people.length}`)
    await expect(page).toHaveURL(/\/friends\?q=AMANDA$/)
    // Searching hides the block of faces nobody has named.
    await expect(page.getByRole('heading', { name: /בלי שם/ })).toHaveCount(0)

    await page.reload()
    await expect(search).toHaveValue('AMANDA')
    await expect(tiles(page)).toHaveCount(matching.length)

    const other = await anotherUser()
    await login(other, 'member')
    await other.goto(page.url())
    await expect(other.getByRole('searchbox', { name: 'חיפוש בוגרים לפי שם' })).toHaveValue('AMANDA')
    await expect(tiles(other)).toHaveCount(matching.length)

    await search.fill('Qwertyuiop')
    await expect(page.getByText('אין אף אחד שמתאים לסינון הזה.')).toBeVisible()
    await expect(tiles(page)).toHaveCount(0)
    await page.getByRole('button', { name: 'ניקוי הסינון' }).click()
    await expect(tiles(page)).toHaveCount(people.length)
    await expect(page).toHaveURL(/\/friends$/)
  })

  test('a card opens the profile in place, and its class photo takes you to the viewer', async ({ page }) => {
    await login(page, 'member')
    const { full, group, unknown } = await demo(page)
    await page.goto('/friends')

    await expect(page.getByRole('heading', { name: `מי זה? (${unknown.length} בלי שם)` })).toBeVisible()
    await expect(page.getByRole('button', { name: '?', exact: true })).toHaveCount(unknown.length)

    await page.getByRole('button', { name: full.name, exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: full.name })).toBeVisible()
    await expect(dialog.getByRole('link', { name: `אימייל: ${full.email}` })).toBeVisible()
    await expect(page).toHaveURL(/\/friends$/)
    await closeButton(page).click()
    await expect(dialog).toHaveCount(0)

    // Outside the panel closes it too, and Escape.
    await page.getByRole('button', { name: full.name, exact: true }).click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await page.getByRole('button', { name: full.name, exact: true }).click()
    await dialog.getByRole('button', { name: group.title }).click()
    await expect(page).toHaveURL(new RegExp(`/p/${full.id}\\?s=${group.slug}$`))
    await expect(panelOf(page, full.name)).toBeVisible()
    await expect(page.getByText('42/48 זוהו')).toBeVisible()
  })

  test('a face nobody has named opens the naming panel from the grid', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/friends')
    await page.getByRole('button', { name: '?', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('עדיין אין שם לתמונה הזו. עזרו למלא את ספר המחזור:')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'אני מזהה! להוספת שם' })).toBeVisible()
    await closeButton(page).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('link', { name: 'חזרה לתמונות המחזור' }).click()
    await expect(page).toHaveURL(/\/$/)
  })
})

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  const noSideScroll = (page: Page) =>
    page.evaluate(() => {
      const main = document.querySelector('main')!
      return document.documentElement.scrollWidth <= document.documentElement.clientWidth && main.scrollWidth <= main.clientWidth
    })

  test('shows the grid instead of the viewer; a card opens the profile in a sheet at /p/:id', async ({ page }) => {
    await login(page, 'member')
    const { full, group } = await demo(page)
    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'ספר המחזור' })).toBeVisible()
    await expect(page.getByRole('button', { name: full.name, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'הצגת התמונה כולה' })).toHaveCount(0)
    await expect(page.getByText(/זוהו/)).toHaveCount(0)
    expect(await noSideScroll(page)).toBe(true)

    await page.getByRole('button', { name: full.name, exact: true }).tap()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: full.name })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/p/${full.id}$`))
    expect(await noSideScroll(page)).toBe(true)

    // With no class photo to jump to, the face in "over the years" opens bigger instead.
    await dialog.getByRole('button', { name: group.title }).tap()
    const enlarged = page.getByRole('dialog', { name: 'צפייה בתמונה' })
    await expect(enlarged).toBeVisible()
    await enlarged.tap()
    await expect(enlarged).toHaveCount(0)

    await closeButton(page).tap()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)
  })

  test('a link to a person opens their sheet over the grid, and a tap outside it closes it', async ({ page }) => {
    await login(page, 'member')
    const { plain } = await demo(page)
    const person = plain[0]
    await page.goto(`/p/${person.id}`)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: person.name })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'ספר המחזור' })).toBeVisible()

    await page.touchscreen.tap(195, 20)
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)
  })

  test('the faces waiting for a name are in the grid and open the naming sheet', async ({ page }) => {
    await login(page, 'member')
    const { unknown } = await demo(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: `מי זה? (${unknown.length} בלי שם)` })).toBeVisible()
    await page.getByRole('button', { name: '?', exact: true }).first().tap()
    await expect(page.getByRole('dialog').getByText('עדיין אין שם לתמונה הזו. עזרו למלא את ספר המחזור:')).toBeVisible()
    expect(await noSideScroll(page)).toBe(true)
  })
})

test.describe('image load failure', () => {
  test('a class photo that cannot load says so, and loads after another try', async ({ page }) => {
    await login(page, 'member')
    const { plain } = await demo(page)
    // Only a failed scene.dzi (the photo's description) is reported; single failed tiles are not.
    await page.route('**/scene.dzi', (route) => route.abort())
    await page.goto('/')

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('התמונה לא נטענה. בדקו את החיבור ונסו שוב.')
    await expect(face(page, plain[0].name)).toHaveCount(0)

    await page.unroute('**/scene.dzi')
    await alert.getByRole('button', { name: 'נסו שוב' }).click()
    await expect(alert).toHaveCount(0)
    await expect(face(page, plain[0].name)).toBeVisible()
    await expect(page.getByText('42/48 זוהו')).toBeVisible()
  })
})

// From here on the tests change the data, so they run last and in this order.
test.describe.serial('naming a face nobody has identified', () => {
  test('a member adds a new name: it shows on the face, after a reload and to another member, and organizers see it', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const { group, unknown, unknownRank, people } = await demo(page)
    const tag = unknown[0]
    const name = 'Zed Testerson'
    await openViewer(page)

    await face(page, UNKNOWN).nth(unknownRank(tag)).click()
    await expect(page.getByText('עדיין אין שם לתמונה הזו. עזרו למלא את ספר המחזור:')).toBeVisible()
    await page.getByRole('button', { name: 'אני מזהה! להוספת שם' }).click()
    await expect(page.getByRole('button', { name: 'הוספת השם' })).toBeDisabled()
    await page.getByLabel('השם של מי שבתמונה').fill(name)
    await page.getByRole('button', { name: 'הוספת השם' }).click()

    // The new profile opens, and the face has its name and is counted.
    await expect(panelOf(page, name)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/p/\\d+\\?s=${group.slug}$`))
    await expect(page.getByText('43/48 זוהו')).toBeVisible()
    await expect(face(page, name)).toBeVisible()
    await expect(face(page, UNKNOWN)).toHaveCount(5)

    await page.reload()
    await expect(face(page, name)).toBeVisible()
    await expect(page.getByText('43/48 זוהו')).toBeVisible()

    const bob = await anotherUser()
    await login(bob, 'member')
    await openViewer(bob, '/', name)
    await expect(bob.getByText('43/48 זוהו')).toBeVisible()
    await expect(face(bob, UNKNOWN)).toHaveCount(5)

    // The organizers' view of the same data: one more person, unclaimed, on that face.
    const organizer = await anotherUser()
    await login(organizer, 'admin')
    const adminPeople: (Person & { name: string })[] = await (await organizer.request.get('/api/people')).json()
    const added = adminPeople.find((p) => p.name === name)!
    expect(adminPeople).toHaveLength(people.length + 1)
    expect(added.claimed).toBe(false)
    const adminScenes: Scene[] = await (await organizer.request.get('/api/admin/scenes')).json()
    expect(adminScenes.find((s) => s.id === group.id)!.tags.find((t) => t.id === tag.id)!.personId).toBe(added.id)
  })

  test('a member picks someone already in the yearbook for another face', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const { group, unknown, unknownRank, wallOnly } = await demo(page)
    const person = wallOnly[0]
    const tag = unknown[0]
    await openViewer(page)
    // The previous test named one face; five are left.
    await expect(face(page, UNKNOWN)).toHaveCount(5)

    await face(page, UNKNOWN).nth(unknownRank(tag)).click()
    await page.getByRole('button', { name: 'אני מזהה! להוספת שם' }).click()
    await page.getByLabel('השם של מי שבתמונה').fill(person.name)
    await expect(page.getByText('כבר מופיעים בספר המחזור? בחרו:')).toBeVisible()
    await page.getByRole('button', { name: person.name, exact: true }).click()

    await expect(panelOf(page, person.name)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/p/${person.id}\\?s=${group.slug}$`))
    await expect(page.getByText('44/48 זוהו')).toBeVisible()
    await expect(face(page, UNKNOWN)).toHaveCount(4)

    const bob = await anotherUser()
    await login(bob, 'member')
    await openViewer(bob, '/', person.name)
    await expect(bob.getByText('44/48 זוהו')).toBeVisible()
  })
})

// Class, year, gender and sort menus show up only once the site has dated posters with classes and people with a
// gender. The demo has neither, so an organizer adds them through the admin API first. Two dated posters make the
// newest one the default class photo, which is why this block is the last one.
test.describe.serial('friends filters', () => {
  const CLASS_A = 'י"ב-1'
  const CLASS_B = 'י"ב-2'
  const CLASS_C = 'מחזור א'

  /** Adds the posters and genders once, whichever test gets here first. Returns the names it used. */
  async function addPostersAndGenders(page: Page) {
    const organizer = page
    await login(organizer, 'admin')
    const { people } = await demo(organizer)
    const [a, b, c, d, e, f] = [...people].sort((x, y) => x.name.localeCompare(y.name, 'he')).slice(0, 6)
    const existing: Scene[] = await (await organizer.request.get('/api/admin/scenes')).json()
    if (existing.some((s) => s.title.startsWith('1996'))) return { a, b, c, d, e, f }

    const genders: [Person, 'f' | 'm'][] = [[a, 'f'], [b, 'm'], [c, 'f'], [d, 'm'], [e, 'f'], [f, 'm']]
    for (const [person, gender] of genders) {
      const res = await organizer.request.patch(`/api/admin/people/${person.id}`, { data: { gender } })
      expect(res.ok()).toBe(true)
    }
    const image = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#c8b8a0' } }).jpeg().toBuffer()
    const poster = async (title: string, who: [Person, string | null][]) => {
      const res = await organizer.request.post('/api/admin/scenes', { multipart: { title, image: { name: 'poster.jpg', mimeType: 'image/jpeg', buffer: image } } })
      expect(res.status()).toBe(201)
      const scene: Scene = await res.json()
      for (const [i, [person, classLabel]] of who.entries()) {
        const tagRes = await organizer.request.post(`/api/admin/scenes/${scene.id}/tags`, { data: { x: 100 + i * 200, y: 200, w: 120, h: 150, personId: person.id } })
        expect(tagRes.status()).toBe(201)
        const tag: Tag = await tagRes.json()
        if (classLabel) expect((await organizer.request.patch(`/api/admin/tags/${tag.id}`, { data: { classLabel } })).ok()).toBe(true)
      }
    }
    await poster('1996 - graduation', [[a, CLASS_A], [b, CLASS_A], [c, CLASS_B], [d, CLASS_B]])
    await poster('2006 - ten years on', [[a, CLASS_C], [e, CLASS_C]])
    return { a, b, c, d, e, f }
  }

  // Once posters have classes, a tile also prints its class under the name, so keep just the two Latin words.
  const tiles = (p: Page) => p.getByRole('button', { name: /^[A-Za-z]+ [A-Za-z]+/ })
  const card = (p: Page, name: string) => p.getByRole('button', { name: new RegExp(`^${name}`) })
  const names = (p: Page) => tiles(p).allTextContents().then((all) => all.map((t) => /^[A-Za-z]+ [A-Za-z]+/.exec(t)![0]))
  const sorted = (...people: Person[]) => people.map((p) => p.name).sort((x, y) => x.localeCompare(y, 'he'))

  test('the year menu narrows to that poster and stays in the address', async ({ page, anotherUser }) => {
    const { a, b, c, d, e } = await addPostersAndGenders(await anotherUser())
    await login(page, 'member')
    const { people } = await demo(page)
    await page.goto('/friends')
    const year = page.getByLabel('שנה')
    await expect(tiles(page)).toHaveCount(people.length)

    await year.selectOption('1996')
    await expect(page).toHaveURL(/year=1996/)
    await expect.poll(() => names(page)).toEqual(sorted(a, b, c, d))
    await expect(page.getByRole('status')).toContainText(`4 מתוך ${people.length}`)

    await page.reload()
    await expect(year).toHaveValue('1996')
    await expect.poll(() => names(page)).toEqual(sorted(a, b, c, d))

    await year.selectOption('2006')
    await expect.poll(() => names(page)).toEqual(sorted(a, e))
    await year.selectOption('')
    await expect(tiles(page)).toHaveCount(people.length)
    await expect(page).not.toHaveURL(/year=/)
  })

  test('the class menu picks a class with its year, and changing the year drops a class it does not have', async ({ page, anotherUser }) => {
    const { c, d, a, e } = await addPostersAndGenders(await anotherUser())
    await login(page, 'member')
    await page.goto('/friends')

    await page.getByLabel('כיתה').selectOption({ label: CLASS_B })
    await expect.poll(() => names(page)).toEqual(sorted(c, d))
    const params = new URL(page.url()).searchParams
    expect(params.get('class')).toBe(CLASS_B)
    expect(params.get('year')).toBe('1996')
    // The face on the tile is that poster's, so the class is printed on the profile's "over the years" card.
    await card(page, c.name).click()
    await expect(page.getByRole('dialog').getByText(CLASS_B)).toBeVisible()
    await closeButton(page).click()

    await page.getByLabel('שנה').selectOption('2006')
    await expect(page.getByLabel('כיתה')).toHaveValue('')
    await expect.poll(() => names(page)).toEqual(sorted(a, e))
  })

  test('boys or girls narrows the list, together with the year', async ({ page, anotherUser }) => {
    const { a, b, c, d, e, f } = await addPostersAndGenders(await anotherUser())
    await login(page, 'member')
    await page.goto('/friends?year=1996')
    const group = page.getByRole('group', { name: 'בנים או בנות' })
    await expect(group.getByRole('button', { name: 'כולם' })).toHaveAttribute('aria-pressed', 'true')

    await group.getByRole('button', { name: 'בנות' }).click()
    await expect(group.getByRole('button', { name: 'בנות' })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => names(page)).toEqual(sorted(a, c))
    await expect(page).toHaveURL(/g=f/)

    await group.getByRole('button', { name: 'בנים' }).click()
    await expect.poll(() => names(page)).toEqual(sorted(b, d))

    await page.goto('/friends?g=f')
    await expect.poll(() => names(page)).toEqual(expect.arrayContaining(sorted(a, c, e)))
    expect(await names(page)).not.toContain(f.name)
  })

  test('sorting by class cuts the grid into a block per class, newest poster first', async ({ page, anotherUser }) => {
    const { a, b, c, d, e } = await addPostersAndGenders(await anotherUser())
    await login(page, 'member')
    await page.goto('/friends')
    await page.getByLabel('מיון').selectOption('class')
    await expect(page).toHaveURL(/sort=class/)

    const titles = () => page.getByRole('heading', { level: 2 }).allTextContents().then((all) => all.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => /·|בלי כיתה/.test(t)))
    await expect.poll(titles).toEqual([`2006 · ${CLASS_C} (2)`, `1996 · ${CLASS_A} (1)`, `1996 · ${CLASS_B} (2)`, expect.stringMatching(/^בלי כיתה \(\d+\)$/)])
    // The first names on the page are the newest class, in its own block.
    expect((await names(page)).slice(0, 2)).toEqual(sorted(a, e))
    expect(await names(page)).toEqual(expect.arrayContaining(sorted(a, b, c, d, e)))

    await page.reload()
    await expect(page.getByLabel('מיון')).toHaveValue('class')
    await page.getByLabel('מיון').selectOption('')
    await expect(page).not.toHaveURL(/sort=/)
  })

  test('a shared link with the filters opens filtered for another member, and a card opens in place', async ({ anotherUser }) => {
    const { a, c } = await addPostersAndGenders(await anotherUser())
    const other = await anotherUser()
    await login(other, 'member')
    await other.goto('/friends?year=1996&g=f')

    await expect(other.getByLabel('שנה')).toHaveValue('1996')
    await expect(other.getByRole('group', { name: 'בנים או בנות' }).getByRole('button', { name: 'בנות' })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => names(other)).toEqual(sorted(a, c))

    await card(other, a.name).click()
    await expect(other.getByRole('dialog').getByRole('heading', { name: a.name })).toBeVisible()
    await expect(other).toHaveURL(/\/friends\?year=1996&g=f$/)
    await closeButton(other).click()

    await other.getByRole('button', { name: 'ניקוי הסינון' }).click()
    await expect(other).toHaveURL(/\/friends$/)
    await expect(other.getByLabel('שנה')).toHaveValue('')
  })
})
