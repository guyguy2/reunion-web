import { expect, login, PASSCODES, test } from './fixtures.ts'

const TABS = [
  { name: 'ספר מחזור', path: '/' },
  { name: 'זכרונות', path: '/memories' },
  { name: 'סרטונים', path: '/videos' },
  { name: 'ציטוטים', path: '/quotes' },
]

// What each tab shows once it has loaded, so a check never runs against the loading screen. On a desktop the
// yearbook is the class photo (its counter is the sign), on a phone it is the grid with this heading.
const PAGE_HEADING: Record<string, string> = {
  '/': 'ספר המחזור',
  '/memories': 'לוח הזכרונות',
  '/videos': 'ספריית הווידאו',
  '/quotes': 'מי אמר את זה?',
}

test.describe('gate', () => {
  test('keeps the button disabled until something is typed, refuses a wrong passcode and lets the right one in', async ({ page }) => {
    await page.goto('/')
    const enter = page.getByRole('button', { name: 'תנו לי להיכנס' })
    await expect(enter).toBeDisabled()

    await page.getByLabel('סיסמה').fill('not-the-passcode')
    await expect(enter).toBeEnabled()
    await enter.click()
    await expect(page.getByRole('alert')).toHaveText('סיסמה שגויה')
    await expect(page.getByLabel('סיסמה')).toBeVisible()
    await expect(page.getByRole('link', { name: 'ספר מחזור' })).toHaveCount(0)

    await page.getByLabel('סיסמה').fill(PASSCODES.member)
    await enter.click()
    await expect(page.getByRole('link', { name: 'ספר מחזור' })).toBeVisible()
    await expect(page.getByLabel('סיסמה')).toHaveCount(0)
  })

  test('a reload keeps the session', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('סיסמה').fill(PASSCODES.member)
    await page.getByRole('button', { name: 'תנו לי להיכנס' }).click()
    await expect(page.getByRole('link', { name: 'ספר מחזור' })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('link', { name: 'ספר מחזור' })).toBeVisible()
    await expect(page.getByLabel('סיסמה')).toHaveCount(0)
  })
})

test.describe('header and tabs', () => {
  test('each tab navigates, marks itself current, and the back button returns', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/')
    await expect(page.getByText('42/48 זוהו')).toBeVisible()

    for (const tab of TABS.slice(1)) {
      await page.getByRole('link', { name: tab.name, exact: true }).click()
      await expect(page).toHaveURL(tab.path)
      await expect(page.getByRole('heading', { name: PAGE_HEADING[tab.path], exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: tab.name, exact: true })).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('link', { name: 'ספר מחזור', exact: true })).not.toHaveAttribute('aria-current', 'page')
    }

    // Quotes is the last tab visited; back goes through videos and memories to the yearbook.
    await page.goBack()
    await expect(page).toHaveURL('/videos')
    await expect(page.getByRole('link', { name: 'סרטונים', exact: true })).toHaveAttribute('aria-current', 'page')
    await page.goBack()
    await expect(page).toHaveURL('/memories')
    await page.goBack()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('link', { name: 'ספר מחזור', exact: true })).toHaveAttribute('aria-current', 'page')
    await page.goForward()
    await expect(page).toHaveURL('/memories')
  })

  test('the profile button and the RSVP shortcut go to the profile and the event page', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/')

    await page.getByRole('link', { name: 'הפרופיל שלי' }).click()
    await expect(page).toHaveURL('/me')
    await expect(page.getByRole('link', { name: 'הפרופיל שלי' })).toHaveAttribute('aria-current', 'page')

    // Nobody has answered yet, so the header asks for an RSVP with the date (the phone bar copy is hidden here).
    await page.getByRole('link', { name: /^אישור הגעה/ }).click()
    await expect(page).toHaveURL('/event')
    await expect(page.getByRole('heading', { name: 'Class Reunion', level: 1 })).toBeVisible()
  })

  test('the title link goes home, and an unknown path shows the yearbook', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/no-such-page')
    await expect(page.getByText('42/48 זוהו')).toBeVisible()
    await expect(page).toHaveURL('/no-such-page')
    await expect(page.getByRole('link', { name: 'ספר מחזור', exact: true })).not.toHaveAttribute('aria-current', 'page')

    await page.getByRole('link', { name: 'Class Reunion' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('link', { name: 'ספר מחזור', exact: true })).toHaveAttribute('aria-current', 'page')
  })

  test('a member has no admin tab and /admin shows the yearbook; an admin has the tab', async ({ page, anotherUser }) => {
    await login(page, 'member')
    await page.goto('/admin')
    await expect(page.getByText('42/48 זוהו')).toBeVisible()
    await expect(page.getByRole('link', { name: 'חדר המנהל' })).toHaveCount(0)

    const boss = await anotherUser()
    await login(boss, 'admin')
    await boss.goto('/')
    const adminTab = boss.getByRole('link', { name: 'חדר המנהל' })
    await expect(adminTab).toBeVisible()
    await adminTab.click()
    await expect(boss).toHaveURL('/admin')
    await expect(adminTab).toHaveAttribute('aria-current', 'page')
  })
})

test.describe('logout', () => {
  test('returns to the gate and a reload stays there', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'ספר מחזור' })).toBeVisible()

    await page.getByRole('button', { name: 'התנתקות' }).click()
    await expect(page.getByLabel('סיסמה')).toBeVisible()
    await page.reload()
    await expect(page.getByLabel('סיסמה')).toBeVisible()
    await expect(page.getByRole('link', { name: 'ספר מחזור' })).toHaveCount(0)
  })

  test('says so and keeps the session when the logout request fails', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'ספר מחזור' })).toBeVisible()

    await page.route('**/api/logout', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }))
    await page.getByRole('button', { name: 'התנתקות' }).click()
    await expect(page.getByRole('alert')).toHaveText('ההתנתקות נכשלה. נסו שוב.')
    await expect(page.getByRole('link', { name: 'ספר מחזור' })).toBeVisible()

    await page.unroute('**/api/logout')
    await page.reload()
    await expect(page.getByRole('link', { name: 'ספר מחזור' })).toBeVisible()
    await expect(page.getByLabel('סיסמה')).toHaveCount(0)
  })
})

test.describe('load failure', () => {
  test('shows the failure card while the load keeps failing, and recovers on retry', async ({ page }) => {
    await login(page, 'member')
    await page.route('**/api/people', (route) => route.fulfill({ status: 500, json: {} }))
    await page.goto('/')

    const card = page.getByRole('alert')
    await expect(card.getByRole('heading', { name: 'האתר לא נטען' })).toBeVisible()
    await expect(card).toContainText('משהו השתבש')
    await expect(page.getByRole('link', { name: 'ספר מחזור' })).toHaveCount(0)

    // Still failing: the card stays.
    await page.getByRole('button', { name: 'נסו שוב' }).click()
    await expect(card.getByRole('heading', { name: 'האתר לא נטען' })).toBeVisible()

    await page.unroute('**/api/people')
    await page.getByRole('button', { name: 'נסו שוב' }).click()
    await expect(page.getByText('42/48 זוהו')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'האתר לא נטען' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'ספר מחזור' })).toBeVisible()
  })

  test('tells the visitor the site is unreachable when the request never gets an answer', async ({ page }) => {
    await login(page, 'member')
    await page.route('**/api/event', (route) => route.abort('connectionrefused'))
    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'האתר לא נטען' })).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('אין חיבור לאתר כרגע')

    await page.unroute('**/api/event')
    await page.getByRole('button', { name: 'נסו שוב' }).click()
    await expect(page.getByText('42/48 זוהו')).toBeVisible()
  })
})

test.describe('feedback', () => {
  test('sends a message, shows the thanks, closes with the button and with Escape, and the organizers get it', async ({ page, anotherUser }) => {
    await login(page, 'member')
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'ספר מחזור' })).toBeVisible()

    const form = page.getByRole('form', { name: 'שליחת משוב' })
    const button = page.getByRole('button', { name: 'משוב', exact: true })
    await expect(form).toHaveCount(0)
    await button.click()
    await expect(form).toBeVisible()
    await expect(button).toHaveAttribute('aria-expanded', 'true')

    // Nothing to send yet.
    const send = form.getByRole('button', { name: 'שליחה' })
    await expect(send).toBeDisabled()

    const message = 'The reunion page is great, e2e feedback 4821'
    await form.getByLabel('ההודעה').fill(message)
    await form.getByLabel('מי כותב? (לא חובה)').fill('Dana Tester')
    await send.click()
    await expect(form.getByRole('status')).toHaveText('תודה! ההודעה נשלחה.')
    await expect(form.getByLabel('ההודעה')).toHaveValue('')

    await form.getByRole('button', { name: 'סגירה' }).click()
    await expect(form).toHaveCount(0)

    // Reopening starts clean, and Escape closes it too.
    await button.click()
    await expect(form).toBeVisible()
    await expect(form.getByRole('status')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(form).toHaveCount(0)

    // It reached the server: the admin API lists it with the sender.
    const boss = await anotherUser()
    await login(boss, 'admin')
    const res = await boss.request.get('/api/admin/feedback')
    expect(res.ok()).toBe(true)
    const list = (await res.json()) as { message: string; sender: string | null; emailed: boolean }[]
    const saved = list.find((f) => f.message === message)
    expect(saved).toBeTruthy()
    expect(saved?.sender).toBe('Dana Tester')
    // No mailer in the test server, so it was saved but not emailed.
    expect(saved?.emailed).toBe(false)
  })
})

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the bottom tab bar works and no tab scrolls sideways', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/')
    await expect(page.getByRole('heading', { name: PAGE_HEADING['/'], exact: true })).toBeVisible()

    const nav = page.getByRole('navigation')
    await expect(nav).toBeVisible()
    // The bar sits at the bottom edge of the screen.
    const box = await nav.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y + box!.height).toBeGreaterThan(844 - 2)
    for (const tab of TABS) await expect(nav.getByRole('link', { name: tab.name, exact: true })).toBeVisible()

    const overflow = () => page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth)
    for (const tab of TABS) {
      await nav.getByRole('link', { name: tab.name, exact: true }).tap()
      await expect(page).toHaveURL(tab.path)
      await expect(page.getByRole('heading', { name: PAGE_HEADING[tab.path], exact: true })).toBeVisible()
      await expect(nav.getByRole('link', { name: tab.name, exact: true })).toHaveAttribute('aria-current', 'page')
      expect(await overflow(), `horizontal overflow on ${tab.path}`).toBeLessThanOrEqual(0)
    }
  })

  test('the RSVP cell in the bar opens the event page, which also fits the screen', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/')
    await page.getByRole('navigation').getByRole('link', { name: 'אישור הגעה' }).tap()
    await expect(page).toHaveURL('/event')
    await expect(page.getByRole('heading', { name: 'Class Reunion', level: 1 })).toBeVisible()
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth)).toBeLessThanOrEqual(0)

    await page.getByRole('link', { name: 'הפרופיל שלי' }).tap()
    await expect(page).toHaveURL('/me')
  })
})
