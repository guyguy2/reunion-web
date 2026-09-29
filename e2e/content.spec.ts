import type { Page } from '@playwright/test'
import { expect, login, test } from './fixtures.ts'

// Tests of one file share one server and its data, in order. Each area below starts with its empty state and then
// builds on what the earlier tests added, so the areas are serial chains and the order matters.

const LAUGH = '\u{1F602}'
// Every add that could succeed types a title in, so the server never asks YouTube or Spotify for one (an outbound
// request the browser blocking cannot stop). That includes the duplicate checks, which must also pass when run alone.
const YOUTUBE = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const SPOTIFY = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'

test.describe('memories', () => {
  test('with no album configured, says so and shows no photos', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/memories')

    await expect(page.getByRole('heading', { name: 'לוח הזכרונות' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Shared album' })).toBeVisible()
    await expect(page.getByText('Photos from trips, parties and old haircuts.')).toBeVisible()
    await expect(page.getByText('קישור האלבום עדיין לא הוגדר.')).toBeVisible()
    await expect(page.getByRole('link', { name: 'לאלבום המלא' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'הוסיפו תמונות משלכם' })).toHaveCount(0)
    // The photos request has answered (empty), so the "developing" placeholder is gone and there is nothing to open.
    await expect(page.getByText('מפתחים תמונות...')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^פתיחת תמונה/ })).toHaveCount(0)
  })
})

test.describe.serial('videos', () => {
  const title = 'Graduation night 96'

  test('the empty shelf says so, and the form can be opened and cancelled', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/videos')

    await expect(page.getByText('עדיין אין קלטות על המדף.')).toBeVisible()
    await page.getByRole('button', { name: '+ הוספת סרטון' }).click()
    const add = page.getByRole('button', { name: 'הוספה לספרייה' })
    // Nothing typed yet, so nothing to add.
    await expect(add).toBeDisabled()
    await page.getByRole('button', { name: 'ביטול' }).click()
    await expect(add).toHaveCount(0)
    await expect(page.getByRole('button', { name: '+ הוספת סרטון' })).toBeVisible()
  })

  test('refuses a link that is not a video, in Hebrew, and keeps the form open', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/videos')
    await page.getByRole('button', { name: '+ הוספת סרטון' }).click()
    await page.getByLabel('קישור לסרטון').fill('https://example.com/watch?v=abc')
    await page.getByRole('button', { name: 'הוספה לספרייה' }).click()

    await expect(page.getByText('הדביקו קישור לסרטון מיוטיוב, אינסטגרם, פייסבוק או X')).toBeVisible()
    await expect(page.getByLabel('קישור לסרטון')).toHaveValue('https://example.com/watch?v=abc')
    await expect(page.getByText('עדיין אין קלטות על המדף.')).toBeVisible()

    // A YouTube link with no video in it is refused the same way.
    await page.getByLabel('קישור לסרטון').fill('https://www.youtube.com/feed/subscriptions')
    await page.getByRole('button', { name: 'הוספה לספרייה' }).click()
    await expect(page.getByText('הדביקו קישור לסרטון מיוטיוב, אינסטגרם, פייסבוק או X')).toBeVisible()
  })

  test('adds a YouTube video by link and title, and it stays after a reload', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/videos')
    await page.getByRole('button', { name: '+ הוספת סרטון' }).click()
    await page.getByLabel('קישור לסרטון').fill(YOUTUBE)
    await page.getByLabel('שם הסרטון (לא חובה)').fill(title)
    await page.getByLabel('כמה מילים (לא חובה)').fill('The whole class on stage')
    await page.getByLabel('מי מוסיף/ה? (לא חובה)').fill('Dana')
    await page.getByRole('button', { name: 'הוספה לספרייה' }).click()

    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: title }) })
    await expect(card).toBeVisible()
    await expect(page.getByText('עדיין אין קלטות על המדף.')).toHaveCount(0)
    // The form closed and cleared itself.
    await expect(page.getByRole('button', { name: '+ הוספת סרטון' })).toBeVisible()
    await expect(card.getByText('The whole class on stage')).toBeVisible()
    await expect(card.getByText('הוסיף/ה: Dana')).toBeVisible()
    await expect(card.getByRole('link', { name: 'לצפייה ב-YouTube' })).toHaveAttribute('href', YOUTUBE)

    await page.reload()
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
  })

  test('refuses the same video twice', async ({ page }) => {
    await login(page, 'member')
    // Make sure it is on the shelf, so this also holds when run alone (a repeat answers 400 and changes nothing).
    await page.request.post('/api/videos', { data: { url: YOUTUBE, title } })
    await page.goto('/videos')
    await page.getByRole('button', { name: '+ הוספת סרטון' }).click()
    await page.getByLabel('קישור לסרטון').fill('https://youtu.be/dQw4w9WgXcQ')
    await page.getByLabel('שם הסרטון (לא חובה)').fill('Same video again')
    await page.getByRole('button', { name: 'הוספה לספרייה' }).click()
    await expect(page.getByText('הסרטון הזה כבר בספרייה')).toBeVisible()
    await expect(page.getByRole('heading', { name: title })).toHaveCount(1)
  })

  test('another member sees it, plays it in a player, and has no remove button', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/videos')
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: title }) })
    await expect(card).toBeVisible()
    await expect(page.getByRole('button', { name: 'הסרה' })).toHaveCount(0)

    // Its thumbnail comes from YouTube and is blocked here, so the tape shows the site's own placeholder button.
    const play = card.getByRole('button', { name: `ניגון ${title}` })
    await expect(play).toBeVisible()
    await play.click()
    // The player itself is external and blocked; the site has swapped the button for its frame.
    await expect(play).toHaveCount(0)
    await expect(card.getByTitle(title)).toBeAttached()
  })

  test('an organizer can remove it, after a confirmation', async ({ page }) => {
    await login(page, 'admin')
    await page.goto('/videos')
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: title }) })
    await card.getByRole('button', { name: 'הסרה' }).click()
    // Backing out leaves it.
    await card.getByRole('button', { name: 'ביטול' }).click()
    await expect(card).toBeVisible()

    await card.getByRole('button', { name: 'הסרה' }).click()
    await card.getByRole('button', { name: 'להסיר באמת' }).click()
    await expect(page.getByText('עדיין אין קלטות על המדף.')).toBeVisible()
    await expect(card).toHaveCount(0)
    await page.reload()
    await expect(page.getByText('עדיין אין קלטות על המדף.')).toBeVisible()
  })
})

test.describe.serial('quotes', () => {
  const text = 'Be kind, rewind, and return it on Monday'
  const wall = (page: Page) => page.getByRole('article').filter({ hasText: text })

  test('the empty wall says so, and a quote needs some text', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/quotes')

    await expect(page.getByRole('heading', { name: 'מי אמר את זה?' })).toBeVisible()
    await expect(page.getByText('הקיר עדיין ריק.')).toBeVisible()
    await page.getByRole('button', { name: '+ הוספת ציטוט' }).click()
    await expect(page.getByRole('button', { name: 'הוספה לקיר' })).toBeDisabled()
    await page.getByRole('button', { name: 'ביטול' }).click()
    await expect(page.getByRole('button', { name: '+ הוספת ציטוט' })).toBeVisible()
  })

  test('adds a quote with who said it and when, and it stays after a reload', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/quotes')
    await page.getByRole('button', { name: '+ הוספת ציטוט' }).click()
    await page.getByLabel('מה אמרו?').fill(text)
    await page.getByLabel('מי אמר/ה? (לא חובה)').fill('Mr. Kowalski')
    await page.getByLabel('מתי ואיפה? (לא חובה)').fill('Every Friday, last period')
    await page.getByLabel('מי מוסיף/ה? (לא חובה)').fill('Dana')
    await page.getByRole('button', { name: 'הוספה לקיר' }).click()

    await expect(wall(page)).toBeVisible()
    await expect(page.getByText('הקיר עדיין ריק.')).toHaveCount(0)
    await expect(wall(page).getByText('Mr. Kowalski')).toBeVisible()
    await expect(wall(page).getByText('Every Friday, last period')).toBeVisible()
    await expect(wall(page).getByText('הוסיף/ה: Dana')).toBeVisible()

    await page.reload()
    await expect(wall(page).getByText('Mr. Kowalski')).toBeVisible()
    await expect(wall(page).getByText('Every Friday, last period')).toBeVisible()
  })

  test('reacting with an emoji shows the count, and picking it again takes it back', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/quotes')
    await wall(page).getByRole('button', { name: 'הוספת תגובת אימוג׳י' }).click()
    await wall(page).getByRole('group', { name: 'בחירת תגובה' }).getByRole('button', { name: LAUGH }).click()

    const pill = wall(page).getByRole('button', { name: `${LAUGH} 1` })
    await expect(pill).toHaveAttribute('aria-pressed', 'true')

    // The choice belongs to this browser, so it is still lit after a reload.
    await page.reload()
    await expect(wall(page).getByRole('button', { name: `${LAUGH} 1` })).toHaveAttribute('aria-pressed', 'true')

    await wall(page).getByRole('button', { name: `${LAUGH} 1` }).click()
    await expect(wall(page).getByRole('button', { name: new RegExp(LAUGH) })).toHaveCount(0)
    await page.reload()
    await expect(wall(page)).toBeVisible()
    await expect(wall(page).getByRole('button', { name: new RegExp(LAUGH) })).toHaveCount(0)
  })

  test('adds a comment, and another member sees it and adds their own reaction', async ({ page, anotherUser }) => {
    await login(page, 'member')
    await page.goto('/quotes')
    await wall(page).getByRole('button', { name: '+ תגובה', exact: true }).click()
    await page.getByLabel('התגובה שלכם').fill('He said it every single week')
    await page.getByLabel('השם שלכם (לא חובה)').fill('Noa')
    await page.getByRole('button', { name: 'פרסום תגובה' }).click()
    await expect(wall(page).getByText('He said it every single week')).toBeVisible()
    await expect(wall(page).getByText('Noa', { exact: true })).toBeVisible()
    // The form closed again.
    await expect(page.getByLabel('התגובה שלכם')).toHaveCount(0)

    await wall(page).getByRole('button', { name: 'הוספת תגובת אימוג׳י' }).click()
    await wall(page).getByRole('button', { name: LAUGH }).click()
    await expect(wall(page).getByRole('button', { name: `${LAUGH} 1` })).toHaveAttribute('aria-pressed', 'true')

    const bob = await anotherUser()
    await login(bob, 'member')
    await bob.goto('/quotes')
    const bobsWall = bob.getByRole('article').filter({ hasText: text })
    await expect(bobsWall.getByText('He said it every single week')).toBeVisible()
    // Someone else's reaction is counted but not lit for this browser.
    await expect(bobsWall.getByRole('button', { name: `${LAUGH} 1` })).toHaveAttribute('aria-pressed', 'false')
    await bobsWall.getByRole('button', { name: `${LAUGH} 1` }).click()
    await expect(bobsWall.getByRole('button', { name: `${LAUGH} 2` })).toHaveAttribute('aria-pressed', 'true')

    await page.reload()
    await expect(wall(page).getByRole('button', { name: `${LAUGH} 2` })).toHaveAttribute('aria-pressed', 'true')
  })

  test('a member cannot remove anything', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/quotes')
    await expect(wall(page)).toBeVisible()
    await expect(page.getByRole('button', { name: 'הסרה', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'הסרת התגובה' })).toHaveCount(0)
  })

  test('an organizer removes the comment, then the quote', async ({ page }) => {
    await login(page, 'admin')
    await page.goto('/quotes')
    await wall(page).getByRole('button', { name: 'הסרת התגובה' }).click()
    await wall(page).getByRole('button', { name: 'להסיר באמת' }).click()
    await expect(wall(page).getByText('He said it every single week')).toHaveCount(0)

    await wall(page).getByRole('button', { name: 'הסרה', exact: true }).click()
    await wall(page).getByRole('button', { name: 'להסיר באמת' }).click()
    await expect(page.getByText('הקיר עדיין ריק.')).toBeVisible()
  })
})

test.describe.serial('event page', () => {
  test('shows the placeholder event: title, countdown, date, venue and schedule', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/event')

    await expect(page.getByRole('heading', { name: 'Class Reunion', level: 1 })).toBeVisible()
    await expect(page.getByText('Placeholder event details.')).toBeVisible()

    // This depends on the placeholder date in content/event.json (2030-01-01): the countdown runs, the date shows
    // 2030, and all of it flips once that date has passed.
    const timer = page.getByRole('timer', { name: 'ספירה לאחור לפגישת המחזור' })
    for (const label of ['ימים', 'שעות', 'דקות', 'שניות']) await expect(timer.getByText(label, { exact: true })).toBeVisible()
    await expect(page.getByText('המסיבה התחילה!')).toHaveCount(0)

    const when = page.locator('section').filter({ has: page.getByRole('heading', { name: 'מתי', exact: true }) })
    await expect(when).toContainText('2030')
    await expect(when).toContainText('18:00')
    await expect(when.getByText('Venue TBD')).toBeVisible()
    // The placeholder has no map link.
    await expect(page.getByRole('link', { name: 'פתיחת מפה' })).toHaveCount(0)
    await expect(page.getByText('One evening, one dance floor, and everyone you passed notes to in class.')).toBeVisible()

    await expect(page.getByRole('heading', { name: 'לוח הזמנים של הערב' })).toBeVisible()
    for (const [time, name, detail] of [
      ['18:00', 'Doors open', 'Name tags and yearbook photos'],
      ['19:00', 'Dinner', ''],
      ['21:00', 'Dance floor', 'Only the music from back then'],
    ]) {
      // A schedule row is plain divs with no role or name, so climb from the title to the row.
      const row = page.getByText(name, { exact: true }).locator('..').locator('..')
      await expect(row).toContainText(time)
      if (detail) await expect(row).toContainText(detail)
    }
    await expect(page.getByText('מספר המבקרים עד כה:')).toBeVisible()
  })

  test('a member without a profile is sent to find themselves before answering', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/event')
    await expect(page.getByRole('heading', { name: 'מגיעים?' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'אהיה שם' })).toHaveCount(0)
    await page.getByRole('link', { name: 'לפרופיל שלי' }).click()
    await expect(page).toHaveURL('/me')
  })

  test('no thank-you list for a member while it is empty, but the organizer sees the editor', async ({ page, anotherUser }) => {
    await login(page, 'member')
    await page.goto('/event')
    await expect(page.getByRole('heading', { name: 'Class Reunion', level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'תודה ענקית' })).toHaveCount(0)

    const boss = await anotherUser()
    await login(boss, 'admin')
    await boss.goto('/event')
    await expect(boss.getByRole('heading', { name: 'תודה ענקית' })).toBeVisible()
    await expect(boss.getByText('עוד לא הודינו לאף אחד.')).toBeVisible()
    await expect(boss.getByRole('button', { name: 'עריכה' })).toBeVisible()
  })

  test('the organizer edits the credits, and they show for everyone after a reload', async ({ page, anotherUser }) => {
    await login(page, 'admin')
    await page.goto('/event')
    await page.getByRole('button', { name: 'עריכה' }).click()

    // It opens with one empty row. Cancelling throws the draft away.
    const names = page.getByRole('textbox', { name: 'שם', exact: true })
    await expect(names).toHaveCount(1)
    await names.first().fill('Discarded')
    await page.getByRole('button', { name: 'ביטול' }).click()
    await expect(page.getByText('עוד לא הודינו לאף אחד.')).toBeVisible()

    await page.getByRole('button', { name: 'עריכה' }).click()
    await names.first().fill('Michael Carter')
    await page.getByRole('textbox', { name: 'מה הוא עשה' }).first().fill('Scanned the yearbooks')
    await page.getByRole('button', { name: 'הוספת שורה' }).click()
    await names.nth(1).fill('Jessica Nguyen')
    await page.getByRole('button', { name: 'הוספת שורה' }).click()
    await names.nth(2).fill('Kevin Patel')
    // Kevin goes to the top, and the blank row for a fourth person is dropped on save.
    await page.getByRole('button', { name: 'העלאת Kevin Patel למעלה' }).click()
    await page.getByRole('button', { name: 'העלאת Kevin Patel למעלה' }).click()
    await page.getByRole('button', { name: 'הוספת שורה' }).click()
    await page.getByRole('button', { name: 'הסרת Jessica Nguyen' }).click()
    await page.getByRole('button', { name: 'שמירה' }).click()

    const credits = page.locator('section').filter({ has: page.getByRole('heading', { name: 'תודה ענקית' }) })
    const items = credits.getByRole('listitem')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toHaveText('Kevin Patel')
    await expect(items.nth(1)).toContainText('Michael Carter')
    await expect(items.nth(1)).toContainText('Scanned the yearbooks')
    await expect(page.getByRole('button', { name: 'שמירה' })).toHaveCount(0)

    await page.reload()
    await expect(page.getByRole('listitem').filter({ hasText: 'Michael Carter' })).toBeVisible()

    // A member has no edit button but reads the same list.
    const bob = await anotherUser()
    await login(bob, 'member')
    await bob.goto('/event')
    await expect(bob.getByRole('heading', { name: 'תודה ענקית' })).toBeVisible()
    await expect(bob.getByRole('listitem').filter({ hasText: 'Kevin Patel' })).toBeVisible()
    await expect(bob.getByRole('listitem').filter({ hasText: 'Scanned the yearbooks' })).toBeVisible()
    await expect(bob.getByRole('button', { name: 'עריכה' })).toHaveCount(0)
  })
})

test.describe.serial('tapes', () => {
  const PLAYER_FAILED = 'הנגן לא נטען. אולי חוסם פרסומות או שאין חיבור. נסו לרענן את הדף.'
  const player = (page: Page) => page.getByRole('complementary', { name: 'נגן הקלטת' })
  const open = async (page: Page) => {
    await page.getByRole('button', { name: 'פתיחת נגן הקלטת' }).click()
    await expect(player(page).getByRole('button', { name: 'הוצאת הקלטת (הסתרת הנגן)' })).toBeVisible()
  }

  test('opens on an empty shelf, and Escape closes the add form first and the player second', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/')
    await expect(page.getByText('42/48 זוהו')).toBeVisible()
    // Closed, only the small tape button shows.
    await expect(player(page).getByRole('button', { name: '+ הוספת קלטת' })).toBeHidden()

    await open(page)
    const deck = player(page)
    await expect(deck.getByText('אין קלטת')).toBeVisible()
    await expect(deck.getByText('אין עדיין קלטות.')).toBeVisible()
    await expect(deck.getByLabel('מדף הקלטות')).toHaveCount(0)

    await deck.getByRole('button', { name: '+ הוספת קלטת' }).click()
    await expect(deck.getByLabel('קישור לשיר, סרטון, אלבום או פלייליסט')).toBeVisible()
    await expect(deck.getByRole('button', { name: 'הוספה למדף' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(deck.getByLabel('קישור לשיר, סרטון, אלבום או פלייליסט')).toHaveCount(0)
    await expect(deck.getByRole('button', { name: '+ הוספת קלטת' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(deck).toBeVisible()
    await expect(page.getByRole('button', { name: 'פתיחת נגן הקלטת' })).toBeVisible()
    await expect(deck.getByRole('button', { name: '+ הוספת קלטת' })).toBeHidden()
  })

  test('refuses links that are not a song, in Hebrew, and keeps the form open', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/')
    await open(page)
    const deck = player(page)
    await deck.getByRole('button', { name: '+ הוספת קלטת' }).click()

    const link = deck.getByLabel('קישור לשיר, סרטון, אלבום או פלייליסט')
    await link.fill('https://example.com/song')
    await deck.getByRole('button', { name: 'הוספה למדף' }).click()
    await expect(deck.getByText('הדביקו קישור לשיר, סרטון, אלבום או פלייליסט מיוטיוב, YouTube Music או ספוטיפיי')).toBeVisible()

    await link.fill('https://spotify.link/abc123')
    await deck.getByRole('button', { name: 'הוספה למדף' }).click()
    await expect(deck.getByText('קישור מקוצר של ספוטיפיי לא נתמך.')).toBeVisible()
    // The form stays open with what was typed, and nothing reached the shelf.
    await expect(link).toHaveValue('https://spotify.link/abc123')
    await expect(deck.getByText('אין קלטת')).toBeVisible()
  })

  test('adds a YouTube link and a Spotify link, and lists both', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/')
    await open(page)
    const deck = player(page)

    await deck.getByRole('button', { name: '+ הוספת קלטת' }).click()
    await deck.getByLabel('קישור לשיר, סרטון, אלבום או פלייליסט').fill(YOUTUBE)
    await deck.getByLabel('שם הקלטת (לא חובה)').fill('Song A')
    await deck.getByLabel('מי מוסיף/ה? (לא חובה)').fill('Dana')
    await deck.getByRole('button', { name: 'הוספה למדף' }).click()

    // The new tape is loaded straight away. Its player script is external and blocked, and the deck says so.
    await expect(deck.getByRole('button', { name: '+ הוספת קלטת' })).toBeVisible()
    await expect(deck.getByText('אין עדיין קלטות.')).toHaveCount(0)
    await expect(deck.getByRole('alert')).toHaveText(PLAYER_FAILED)
    await expect(deck.getByText('הוסיף/ה: Dana')).toBeVisible()

    // The same video again, as a short link, is caught.
    await deck.getByRole('button', { name: '+ הוספת קלטת' }).click()
    await deck.getByLabel('קישור לשיר, סרטון, אלבום או פלייליסט').fill('https://youtu.be/dQw4w9WgXcQ')
    await deck.getByLabel('שם הקלטת (לא חובה)').fill('Same tape again')
    await deck.getByRole('button', { name: 'הוספה למדף' }).click()
    await expect(deck.getByText('הקלטת הזו כבר על המדף')).toBeVisible()

    await deck.getByLabel('קישור לשיר, סרטון, אלבום או פלייליסט').fill(SPOTIFY)
    await deck.getByLabel('שם הקלטת (לא חובה)').fill('Song B')
    await deck.getByRole('button', { name: 'הוספה למדף' }).click()
    await expect(deck.getByRole('button', { name: '+ הוספת קלטת' })).toBeVisible()

    const shelf = deck.getByLabel('מדף הקלטות')
    await expect(shelf.getByRole('option')).toHaveText(['Song A (יוטיוב) - Dana', 'Song B (ספוטיפיי) - Dana'])
    // The last one added is the one loaded.
    await expect(shelf).toHaveValue(await shelf.getByRole('option', { name: /Song B/ }).getAttribute('value') ?? '')
    await expect(deck.getByRole('alert')).toHaveText(PLAYER_FAILED)
    await expect(deck.getByRole('button', { name: 'נגן', exact: true })).toBeDisabled()

    await shelf.selectOption({ label: 'Song A (יוטיוב) - Dana' })
    await expect(deck.getByRole('alert')).toHaveText(PLAYER_FAILED)
  })

  test('the shelf survives a reload and another member sees it', async ({ page, anotherUser }) => {
    await login(page, 'member')
    await page.goto('/')
    await open(page)
    await expect(player(page).getByLabel('מדף הקלטות').getByRole('option')).toHaveText(['Song A (יוטיוב) - Dana', 'Song B (ספוטיפיי) - Dana'])

    const bob = await anotherUser()
    await login(bob, 'member')
    await bob.goto('/')
    await open(bob)
    await expect(player(bob).getByLabel('מדף הקלטות').getByRole('option')).toHaveText(['Song A (יוטיוב) - Dana', 'Song B (ספוטיפיי) - Dana'])
    // Members cannot take tapes off the shelf.
    await expect(player(bob).getByRole('button', { name: 'הסרת הקלטת מהמדף' })).toHaveCount(0)
  })

  test('an organizer can take a tape off the shelf', async ({ page }) => {
    await login(page, 'admin')
    await page.goto('/')
    await open(page)
    const deck = player(page)
    await deck.getByRole('button', { name: 'הסרת הקלטת מהמדף' }).click()
    await deck.getByRole('button', { name: 'להסיר באמת' }).click()

    // Song A was showing, so Song B is the only one left, and the shelf picker is gone.
    await expect(deck.getByLabel('מדף הקלטות')).toHaveCount(0)
    await expect(deck.getByText('הוסיף/ה: Dana')).toBeVisible()
    await page.reload()
    await open(page)
    await expect(player(page).getByLabel('מדף הקלטות')).toHaveCount(0)
    await expect(player(page).getByText('אין עדיין קלטות.')).toHaveCount(0)
  })
})
