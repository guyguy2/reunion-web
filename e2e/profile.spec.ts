import sharp from 'sharp'
import { expect, login, test } from './fixtures.ts'

type Page = Parameters<typeof login>[0]

interface Listed {
  id: number
  name: string
  claimed: boolean
  hasPin: boolean
  inMemoriam: boolean
  city: string | null
  bio: string | null
}

/** A profile this test owns: its id and name, the key that signs a browser in as it, and the personal code. */
interface Owner {
  id: number
  name: string
  token: string
  pin: string
}

const PIN = 'e2e-code-1'

async function roster(page: Page): Promise<Listed[]> {
  const res = await page.request.get('/api/people')
  expect(res.ok(), 'GET /api/people').toBe(true)
  return res.json()
}

/** The next demo profile nobody has claimed. Earlier tests take theirs, so each test gets its own. */
async function nextUnclaimed(page: Page): Promise<Listed> {
  const person = (await roster(page)).find((p) => !p.claimed && !p.inMemoriam)
  expect(person, 'an unclaimed demo profile').toBeDefined()
  return person!
}

/** A claimed demo profile: the seed marks every third one as claimed, with no personal code and no key (tests that claim get a code). */
async function aDemoClaimed(page: Page): Promise<Listed> {
  const person = (await roster(page)).find((p) => p.claimed && !p.hasPin && !p.inMemoriam)
  expect(person, 'a claimed demo profile').toBeDefined()
  return person!
}

// Profiles claimed through the API by the running test. They are released afterwards, so every test starts from the
// same pool of unclaimed demo profiles (there are only 40) and a later test cannot inherit an earlier one's claim.
const claimedByTest: Owner[] = []

test.afterEach(async ({ page }) => {
  for (const owner of claimedByTest.splice(0)) await page.request.delete('/api/me', { headers: { 'x-edit-token': owner.token } })
})

/** Claims the next free demo profile through the API (the claim form itself is covered by its own tests). Needs the member cookie. */
async function claimByApi(page: Page, fields: { email?: string } = {}): Promise<Owner> {
  const person = await nextUnclaimed(page)
  const res = await page.request.post(`/api/people/${person.id}/claim`, { data: { pin: PIN, ...fields } })
  expect(res.ok(), 'claim').toBe(true)
  const { token } = await res.json()
  const owner = { id: person.id, name: person.name, token, pin: PIN }
  claimedByTest.push(owner)
  return owner
}

/** Makes this browser context remember `who`, the way it would after claiming or logging in. Call before the first goto. */
async function signIn(page: Page, who: { id: number; token: string }, opts: { welcome?: boolean } = {}) {
  await page.addInitScript(
    ({ token, id, welcome }) => {
      // Once per tab, so logging out or removing the profile is not undone by the next page load.
      if (sessionStorage.getItem('e2e.seeded')) return
      sessionStorage.setItem('e2e.seeded', '1')
      localStorage.setItem('reunion.editToken', token)
      if (!welcome) sessionStorage.setItem('reunion.welcomed', String(id))
    },
    { token: who.token, id: who.id, welcome: opts.welcome ?? false },
  )
}

/** Escape closes the Welcome dialog (it opens once per browser session after the site knows who you are). */
async function closeWelcome(page: Page) {
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
}

async function png(color: string): Promise<Buffer> {
  return sharp({ create: { width: 48, height: 60, channels: 3, background: color } }).png().toBuffer()
}

const upload = async (page: Page, label: string, index: 'first' | 'last', color: string) =>
  page.getByLabel(label)[index]().setInputFiles({ name: `${color}.png`, mimeType: 'image/png', buffer: await png(color) })

const firstName = (name: string) => name.split(' ')[0]

test.describe('claiming a profile', () => {
  test('a member finds themself in the yearbook, claims the profile with a code and is greeted', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const who = await nextUnclaimed(page)

    // Nobody is signed in to a profile yet, so the profile page points to the yearbook.
    await page.goto('/me')
    await expect(page.getByRole('heading', { name: 'לא מופיעים באף תמונה?' })).toBeVisible()
    await page.getByRole('link', { name: 'לספר המחזור', exact: true }).click()

    const search = page.getByLabel('חיפוש בוגרים לפי שם')
    await search.fill(who.name)
    await search.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/p/${who.id}(\\?|$)`))
    await expect(page.getByRole('heading', { name: who.name })).toBeVisible()
    await expect(page.getByText('אף אחד עדיין לא לקח בעלות על הפרופיל הזה.')).toBeVisible()

    await page.getByRole('button', { name: 'זה הפרופיל שלי! אני רוצה לערוך אותו' }).click()
    const claim = page.getByRole('button', { name: 'זה הפרופיל שלי', exact: true })
    await page.getByLabel('בחרו קוד אישי').fill('abc')
    await expect(claim).toBeDisabled()
    await expect(page.getByText('בלי מייל, אם תשכחו את הקוד רק מארגן יוכל להחזיר אתכם לפרופיל.')).toBeVisible()
    await page.getByLabel('בחרו קוד אישי').fill(PIN)
    await claim.click()

    await expect(page).toHaveURL(/\/me\?welcome=1$/)
    const welcome = page.getByRole('dialog')
    await expect(welcome.getByRole('heading', { name: new RegExp(`, ${firstName(who.name)}!$`) })).toBeVisible()
    await expect(welcome.getByText('עוד לא ענית')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(welcome).toBeHidden()

    // The profile is theirs now: the form is filled from it and the private link is handed out.
    await expect(page.getByText('ברוכים הבאים!')).toBeVisible()
    await expect(page.getByLabel('שם', { exact: true })).toHaveValue(who.name)
    await expect(page.getByText('יש לכם קוד אישי.')).toBeVisible()
    await expect(page.getByLabel('קישור עריכה פרטי')).toHaveValue(/\/me\/.+/)

    // Another member sees it as taken, with the sign-in option instead of the claim button.
    const bob = await anotherUser()
    await login(bob, 'member')
    await bob.goto(`/p/${who.id}`)
    await expect(bob.getByRole('heading', { name: who.name })).toBeVisible()
    await expect(bob.getByRole('button', { name: 'זה הפרופיל שלי. כניסה עם הקוד האישי' })).toBeVisible()
    await expect(bob.getByRole('button', { name: 'זה הפרופיל שלי! אני רוצה לערוך אותו' })).toHaveCount(0)
    await expect(bob.getByText('אף אחד עדיין לא לקח בעלות על הפרופיל הזה.')).toHaveCount(0)
    expect((await roster(bob)).find((p) => p.id === who.id)?.claimed).toBe(true)
  })

  test('the claim form refuses a bad email in Hebrew, and a real email is optional but accepted', async ({ page }) => {
    await login(page, 'member')
    const who = await nextUnclaimed(page)
    await page.goto(`/p/${who.id}`)
    await page.getByRole('button', { name: 'זה הפרופיל שלי! אני רוצה לערוך אותו' }).click()

    const nudge = page.getByText('בלי מייל, אם תשכחו את הקוד רק מארגן יוכל להחזיר אתכם לפרופיל.')
    await expect(nudge).toBeVisible()
    await page.getByLabel('בחרו קוד אישי').fill(PIN)
    await page.getByLabel('אימייל (לא חובה)').fill('a@b')
    await expect(nudge).toBeHidden()
    await page.getByRole('button', { name: 'זה הפרופיל שלי', exact: true }).click()
    await expect(page.getByText('כתובת האימייל לא תקינה')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/p/${who.id}$`))
    expect((await roster(page)).find((p) => p.id === who.id)?.claimed).toBe(false)

    await page.getByLabel('אימייל (לא חובה)').fill('claim.email@example.com')
    await page.getByRole('button', { name: 'זה הפרופיל שלי', exact: true }).click()
    await expect(page).toHaveURL(/\/me\?welcome=1$/)
    await closeWelcome(page)
    await expect(page.getByLabel('אימייל', { exact: true })).toHaveValue('claim.email@example.com')
  })
})

test.describe('editing the profile', () => {
  test('changes are saved, kept after a reload, and shown to another member in the person panel', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const me = await claimByApi(page)
    await signIn(page, me)
    await page.goto('/me')

    await page.getByLabel('כינוי').fill('Zippy')
    await page.getByLabel('איפה גרים היום?').fill('Testville, TX')
    await page.getByLabel('מה קרה מאז?').fill('Runs the school fair.\nStill has the yearbook.')
    await page.getByLabel('טלפון', { exact: true }).fill('050-1234567')
    await page.getByLabel('אינסטגרם', { exact: true }).fill('@zippy_e2e')
    await page.getByLabel('אתר או קישור נוסף').fill('zippy-e2e.example.com')
    await page.getByRole('button', { name: 'אולי', exact: true }).click()

    // The browser's own check lets "a@b" through, so the server refuses it, and nothing is saved.
    await page.getByLabel('אימייל', { exact: true }).fill('a@b')
    await page.getByRole('button', { name: 'שמירת הפרופיל' }).click()
    await expect(page.getByRole('status')).toHaveText('כתובת האימייל לא תקינה')
    expect((await roster(page)).find((p) => p.id === me.id)?.city).toBeNull()

    await page.getByLabel('אימייל', { exact: true }).fill('zippy@example.com')
    await page.getByRole('button', { name: 'שמירת הפרופיל' }).click()
    await expect(page.getByRole('status')).toHaveText('נשמר. נראה מעולה!')

    await page.reload()
    await expect(page.getByLabel('כינוי')).toHaveValue('Zippy')
    await expect(page.getByLabel('איפה גרים היום?')).toHaveValue('Testville, TX')
    await expect(page.getByLabel('מה קרה מאז?')).toHaveValue('Runs the school fair.\nStill has the yearbook.')
    await expect(page.getByLabel('אימייל', { exact: true })).toHaveValue('zippy@example.com')
    await expect(page.getByLabel('טלפון', { exact: true })).toHaveValue('050-1234567')
    // A handle is kept bare, and a bare domain becomes a link.
    await expect(page.getByLabel('אינסטגרם', { exact: true })).toHaveValue('zippy_e2e')
    await expect(page.getByLabel('אתר או קישור נוסף')).toHaveValue('https://zippy-e2e.example.com')
    await expect(page.getByRole('button', { name: 'אולי', exact: true })).toHaveAttribute('aria-pressed', 'true')

    const bob = await anotherUser()
    await login(bob, 'member')
    await bob.goto(`/p/${me.id}`)
    await expect(bob.getByRole('heading', { name: me.name })).toBeVisible()
    await expect(bob.getByText('"Zippy"')).toBeVisible()
    await expect(bob.getByText('Testville, TX')).toBeVisible()
    await expect(bob.getByText('Runs the school fair.')).toBeVisible()
    await expect(bob.getByText('אולי...')).toBeVisible()
    await expect(bob.getByRole('link', { name: 'אימייל: zippy@example.com' })).toHaveAttribute('href', 'mailto:zippy@example.com')
    await expect(bob.getByRole('link', { name: 'טלפון: 050-1234567' })).toHaveAttribute('href', 'tel:0501234567')
    await expect(bob.getByRole('link', { name: '@zippy_e2e' })).toHaveAttribute('href', 'https://instagram.com/zippy_e2e')
    await expect(bob.getByRole('link', { name: 'zippy-e2e.example.com' })).toHaveAttribute('href', 'https://zippy-e2e.example.com')
  })

  test('a contact detail marked as hidden stays off the panel other members see', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const me = await claimByApi(page, { email: 'hidden.mail@example.com' })
    await page.request.patch('/api/me', { headers: { 'x-edit-token': me.token }, data: { phone: '050-7654321', city: 'Hideaway, WA' } })
    await signIn(page, me)
    await page.goto('/me')

    await page.getByLabel('להציג את האימייל שלי').uncheck()
    await page.getByRole('button', { name: 'שמירת הפרופיל' }).click()
    await expect(page.getByRole('status')).toHaveText('נשמר. נראה מעולה!')

    // The owner still has everything.
    await page.reload()
    await expect(page.getByLabel('אימייל', { exact: true })).toHaveValue('hidden.mail@example.com')
    await expect(page.getByLabel('להציג את האימייל שלי')).not.toBeChecked()
    await expect(page.getByLabel('להציג את הטלפון שלי')).toBeChecked()

    const bob = await anotherUser()
    await login(bob, 'member')
    await bob.goto(`/p/${me.id}`)
    await expect(bob.getByText('Hideaway, WA')).toBeVisible()
    await expect(bob.getByRole('link', { name: 'טלפון: 050-7654321' })).toBeVisible()
    await expect(bob.getByRole('link', { name: /אימייל:/ })).toHaveCount(0)
    await expect(bob.getByText('hidden.mail@example.com')).toHaveCount(0)
  })

  test('typed text is kept while a photo uploads, but an unsaved draft does not survive a reload', async ({ page }) => {
    await login(page, 'member')
    const me = await claimByApi(page)
    await signIn(page, me)
    await page.goto('/me')

    await page.getByLabel('כינוי').fill('Half typed')
    await page.getByLabel('מה קרה מאז?').fill('Not saved yet')
    await upload(page, 'העלאת תמונה', 'first', '#2255cc')
    await expect(page.getByText('הראשית')).toHaveCount(2)
    // The upload reloads the profile, and the form keeps what was typed.
    await expect(page.getByLabel('כינוי')).toHaveValue('Half typed')
    await expect(page.getByLabel('מה קרה מאז?')).toHaveValue('Not saved yet')

    // Nothing stores a draft in the browser: a reload starts over from what was saved.
    await page.reload()
    await expect(page.getByLabel('שם', { exact: true })).toHaveValue(me.name)
    await expect(page.getByLabel('כינוי')).toHaveValue('')
    await expect(page.getByLabel('מה קרה מאז?')).toHaveValue('')
  })
})

test.describe('personal code', () => {
  test('in a fresh browser the name and the right code open the profile, and a wrong code is refused', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const me = await claimByApi(page)
    const stranger = await nextUnclaimed(page)
    const other = await anotherUser()
    await login(other, 'member')
    await other.goto('/me')

    await expect(other.getByRole('heading', { name: 'כבר יש לכם פרופיל?' })).toBeVisible()
    // Only claimed profiles can be signed in to.
    await other.getByLabel('השם שלכם').fill(stranger.name)
    await expect(other.getByRole('button', { name: stranger.name })).toHaveCount(0)
    await other.getByLabel('השם שלכם').fill(me.name)
    await other.getByRole('button', { name: me.name }).click()

    await other.getByLabel(`הקוד האישי של ${me.name}`).fill('not-the-code')
    await other.getByRole('button', { name: 'כניסה', exact: true }).click()
    await expect(other.getByText('הקוד לא נכון')).toBeVisible()
    await expect(other).toHaveURL(/\/me$/)

    await other.getByLabel(`הקוד האישי של ${me.name}`).fill(me.pin)
    await other.getByRole('button', { name: 'כניסה', exact: true }).click()
    await expect(other.getByRole('dialog').getByRole('heading', { name: new RegExp(`, ${firstName(me.name)}!$`) })).toBeVisible()
    await other.keyboard.press('Escape')
    await expect(other.getByLabel('שם', { exact: true })).toHaveValue(me.name)
    await expect(other.getByText('יש לכם קוד אישי.')).toBeVisible()

    // "Not me" signs this browser out of the profile again.
    await other.getByRole('button', { name: /זה לא הפרופיל שלי/ }).click()
    await other.goto('/me')
    await expect(other.getByRole('heading', { name: 'לא מופיעים באף תמונה?' })).toBeVisible()
  })

  test('the person panel offers the code sign-in, and a demo profile without a code cannot get a link by email', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const me = await claimByApi(page)
    const other = await anotherUser()
    await login(other, 'member')
    await other.goto(`/p/${me.id}`)
    await other.getByRole('button', { name: 'זה הפרופיל שלי. כניסה עם הקוד האישי' }).click()
    await other.getByLabel(`הקוד האישי של ${me.name}`).fill(me.pin)
    await other.getByRole('button', { name: 'כניסה', exact: true }).click()
    await expect(other).toHaveURL(/\/me$/)
    await closeWelcome(other)
    await expect(other.getByLabel('שם', { exact: true })).toHaveValue(me.name)

    // A claimed demo profile has no code and no email, and the test server has no mailer.
    const demo = await aDemoClaimed(page)
    const third = await anotherUser()
    await login(third, 'member')
    await third.goto(`/p/${demo.id}`)
    await third.getByRole('button', { name: 'זה הפרופיל שלי. כניסה עם הקוד האישי' }).click()
    await expect(third.getByText('לפרופיל הזה עדיין אין קוד אישי.')).toBeVisible()
    await third.getByRole('button', { name: 'שלחו לי קישור כניסה למייל' }).click()
    await expect(third.getByText('שליחת מיילים עוד לא הוגדרה באתר. בקשו מהמארגנים לאפס את הפרופיל.')).toBeVisible()
  })

  test('choosing a new code replaces the old one', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const me = await claimByApi(page)
    await signIn(page, me)
    await page.goto('/me')

    await page.getByRole('button', { name: 'החלפת הקוד' }).click()
    await page.getByLabel('קוד אישי', { exact: true }).fill('new-code-2')
    await page.getByRole('button', { name: 'שמירה', exact: true }).click()
    await expect(page.getByText('הקוד נשמר. עכשיו אפשר להיכנס מכל מכשיר.')).toBeVisible()
    await expect(page.getByText('יש לכם קוד אישי.')).toBeVisible()

    const other = await anotherUser()
    await login(other, 'member')
    const wrong = await other.request.post(`/api/people/${me.id}/login`, { data: { pin: me.pin } })
    expect(wrong.status()).toBe(401)
    const right = await other.request.post(`/api/people/${me.id}/login`, { data: { pin: 'new-code-2' } })
    expect(right.status()).toBe(200)
  })
})

test.describe('notes', () => {
  test('a signed and an anonymous note reach the owner, who reads them and the badge counts down', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const owner = await claimByApi(page)

    // The sender needs a profile of their own to sign a note.
    const bob = await anotherUser()
    await login(bob, 'member')
    const created = await bob.request.post('/api/people', { data: { name: 'Sam Sender', pin: PIN } })
    expect(created.status()).toBe(201)
    const sender = await created.json()
    await signIn(bob, { id: sender.person.id, token: sender.token })

    await bob.goto(`/p/${owner.id}`)
    const write = async (message: string, anonymous: boolean) => {
      await bob.getByRole('button', { name: 'שליחת פתק' }).click()
      const form = bob.getByRole('form', { name: `פתק ל${owner.name}` })
      await form.getByLabel('מה כתוב בפתק').fill(message)
      if (anonymous) await form.getByLabel('לשלוח בלי שם (אנונימי)').check()
      else await expect(form.getByLabel('לשלוח בלי שם (אנונימי)')).not.toBeChecked()
      await form.getByRole('button', { name: 'לקפל ולשלוח' }).click()
      await expect(bob.getByText('הפתק קופל ונשלח!')).toBeVisible()
      await bob.keyboard.press('Escape')
      await expect(form).toBeHidden()
    }
    await write('See you at the reunion, Sam here', false)
    await write('You never returned my mixtape', true)

    // Someone with no profile can only send anonymously.
    const guest = await anotherUser()
    await login(guest, 'member')
    await guest.goto(`/p/${owner.id}`)
    await guest.getByRole('button', { name: 'שליחת פתק' }).click()
    const guestForm = guest.getByRole('form', { name: `פתק ל${owner.name}` })
    await expect(guestForm.getByLabel('לשלוח בלי שם (אנונימי)')).toBeChecked()
    await expect(guestForm.getByLabel('לשלוח בלי שם (אנונימי)')).toBeDisabled()
    await expect(guestForm.getByText('כדי לחתום בשמכם צריך קודם')).toBeVisible()

    // The owner sees the count in the header from any page.
    await signIn(page, owner)
    await page.goto('/')
    await expect(page.getByLabel('2 פתקים חדשים')).toBeVisible()
    await page.getByRole('link', { name: /הפרופיל שלי/ }).click()
    await expect(page.getByRole('heading', { name: 'פתקים שקיבלתם' })).toBeVisible()
    const signed = page.getByRole('button', { name: 'פתיחת פתק מSam Sender' })
    const anonymousNote = page.getByRole('button', { name: 'פתיחת פתק ממישהו מהמחזור' })
    await expect(signed).toBeVisible()
    await expect(anonymousNote).toBeVisible()

    await signed.click()
    await expect(page.getByText('See you at the reunion, Sam here')).toBeVisible()
    await expect(page.getByLabel('1 פתקים חדשים')).toBeVisible()
    await anonymousNote.click()
    await expect(page.getByText('You never returned my mixtape')).toBeVisible()
    await expect(page.getByLabel(/פתקים חדשים/)).toHaveCount(0)

    // Only the signed note can be answered.
    await expect(page.getByRole('button', { name: 'לענות' })).toHaveCount(1)
    await page.getByRole('button', { name: 'לענות' }).click()
    await expect(page.getByRole('form', { name: 'פתק לSam Sender' })).toBeVisible()
    await page.keyboard.press('Escape')

    // Throwing one away asks first, and the other stays.
    await page.getByRole('button', { name: 'לזרוק', exact: true }).last().click()
    await page.getByRole('button', { name: 'להשאיר' }).click()
    await expect(page.getByText('You never returned my mixtape')).toBeVisible()
    await page.getByRole('button', { name: 'לזרוק', exact: true }).nth(1).click()
    await page.getByRole('button', { name: 'לזרוק לפח' }).click()
    const messages = page.getByText(/See you at the reunion|You never returned my mixtape/)
    await expect(messages).toHaveCount(1)
    await page.reload()
    await expect(page.getByText('פתקים שקיבלתם')).toBeVisible()
    await expect(messages).toHaveCount(1)
  })

  test('a profile that nobody has claimed can still be sent a note', async ({ page }) => {
    await login(page, 'member')
    const who = await nextUnclaimed(page)
    await page.goto(`/p/${who.id}`)
    await page.getByRole('button', { name: 'שליחת פתק' }).click()
    const form = page.getByRole('form', { name: `פתק ל${who.name}` })
    await expect(form.getByText(`${who.name} עוד לא הצטרפו לאתר. הפתק יחכה להם עד שיצטרפו.`)).toBeVisible()
    await form.getByLabel('מה כתוב בפתק').fill('Waiting for you')
    await form.getByRole('button', { name: 'לקפל ולשלוח' }).click()
    await expect(page.getByText('הפתק קופל ונשלח!')).toBeVisible()

    // Whoever claims the profile later finds it waiting.
    const claim = await page.request.post(`/api/people/${who.id}/claim`, { data: { pin: PIN } })
    const { token } = await claim.json()
    await signIn(page, { id: who.id, token })
    await page.goto('/')
    await expect(page.getByLabel('1 פתקים חדשים')).toBeVisible()
  })
})

test.describe('RSVP', () => {
  test('the event page saves the answer, the header follows it and other members see it', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const me = await claimByApi(page)
    await signIn(page, me)
    await page.goto('/')
    await expect(page.getByRole('link', { name: /אישור הגעה/ })).toBeVisible()

    await page.goto('/event')
    const yes = page.getByRole('button', { name: 'אהיה שם', exact: true })
    const maybe = page.getByRole('button', { name: 'אולי', exact: true })
    await expect(yes).toHaveAttribute('aria-pressed', 'false')
    await yes.click()
    await expect(yes).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('link', { name: /מגיעים!/ })).toBeVisible()

    await page.reload()
    await expect(yes).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('link', { name: /מגיעים!/ })).toBeVisible()

    const bob = await anotherUser()
    await login(bob, 'member')
    await bob.goto(`/p/${me.id}`)
    await expect(bob.getByText('אהיה שם!')).toBeVisible()

    await maybe.click()
    await expect(maybe).toHaveAttribute('aria-pressed', 'true')
    await expect(yes).toHaveAttribute('aria-pressed', 'false')
    await bob.reload()
    await expect(bob.getByText('אולי...')).toBeVisible()
  })

  test('someone without a profile is sent to the profile page, and the Welcome dialog shows and changes the answer', async ({ page, anotherUser }) => {
    await login(page, 'member')
    await page.goto('/event')
    await expect(page.getByText('אישור ההגעה נשמר בפרופיל שלכם.')).toBeVisible()
    await page.getByRole('link', { name: 'לפרופיל שלי', exact: true }).click()
    await expect(page).toHaveURL(/\/me$/)

    const me = await claimByApi(page)
    await page.request.patch('/api/me', { headers: { 'x-edit-token': me.token }, data: { attending: 'no' } })
    const owner = await anotherUser()
    await login(owner, 'member')
    await signIn(owner, me, { welcome: true })
    await owner.goto('/')
    const welcome = owner.getByRole('dialog')
    await expect(welcome.getByText('אישור ההגעה שלך:')).toContainText('לא אוכל להגיע')
    await welcome.getByRole('button', { name: 'אהיה שם', exact: true }).click()
    await expect(welcome.getByText('אישור ההגעה שלך:')).toContainText('אהיה שם!')
    await closeWelcome(owner)
    await expect(owner.getByRole('link', { name: /מגיעים!/ })).toBeVisible()
    await owner.goto('/me')
    await expect(owner.getByRole('button', { name: 'אהיה שם', exact: true })).toHaveAttribute('aria-pressed', 'true')
  })
})

test.describe('photos', () => {
  test('a now and a then photo show in the profile and the panel, and can be removed', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const me = await claimByApi(page)
    await signIn(page, me)
    await page.goto('/me')

    // The demo profile starts with one "then" photo and no "now" photo.
    const remove = page.getByRole('button', { name: 'הסרה', exact: true })
    await expect(remove).toHaveCount(1)
    await expect(page.getByText('זה המקסימום (3).')).toHaveCount(0)

    await upload(page, 'העלאת תמונה', 'first', '#22aa66')
    await expect(remove).toHaveCount(2)
    await expect(page.getByText('הראשית')).toHaveCount(2)
    // "Add another" now, for both kinds.
    await upload(page, 'הוספת תמונה', 'last', '#aa3366')
    await expect(remove).toHaveCount(3)

    const bob = await anotherUser()
    await login(bob, 'member')
    await bob.goto(`/p/${me.id}`)
    await expect(bob.getByRole('heading', { name: me.name })).toBeVisible()
    await expect(bob.getByRole('img', { name: 'היום' })).toBeVisible()
    await expect(bob.getByRole('img', { name: 'אז', exact: true })).toBeVisible()
    await expect(bob.getByRole('heading', { name: 'עוד תמונות' })).toBeVisible()

    // The "now" photo comes first in the page, so its remove button does too.
    await remove.first().click()
    await expect(remove).toHaveCount(2)
    await page.reload()
    await expect(remove).toHaveCount(2)
    await bob.reload()
    await expect(bob.getByRole('heading', { name: me.name })).toBeVisible()
    await expect(bob.getByRole('img', { name: 'היום' })).toHaveCount(0)
    await expect(bob.getByRole('heading', { name: 'עוד תמונות' })).toBeVisible()

    // Removing the extra "then" photo leaves the original one.
    await remove.last().click()
    await expect(remove).toHaveCount(1)
    await bob.reload()
    await expect(bob.getByRole('heading', { name: me.name })).toBeVisible()
    await expect(bob.getByRole('heading', { name: 'עוד תמונות' })).toHaveCount(0)
  })
})

test.describe('signing in from a link', () => {
  test('an organizer link signs a fresh browser in once, and the same link is refused the second time', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const me = await claimByApi(page)

    const admin = await anotherUser()
    await login(admin, 'admin')
    const res = await admin.request.post(`/api/admin/people/${me.id}/signin-link`)
    expect(res.status()).toBe(200)
    const link = await res.json()
    expect(link.name).toBe(me.name)
    const path = new URL(link.url).pathname
    expect(path).toMatch(/^\/signin\/.+/)

    const fresh = await anotherUser()
    await login(fresh, 'member')
    await fresh.goto(path)
    await expect(fresh).toHaveURL(/\/me$/)
    await closeWelcome(fresh)
    await expect(fresh.getByLabel('שם', { exact: true })).toHaveValue(me.name)

    const again = await anotherUser()
    await login(again, 'member')
    await again.goto(path)
    await expect(again.getByText('הקישור כבר לא בתוקף. בקשו קישור חדש.')).toBeVisible()
    await expect(again).toHaveURL(new RegExp(`${path}$`))
    await again.getByRole('button', { name: 'לפרופיל שלי' }).click()
    await expect(again.getByRole('heading', { name: 'כבר יש לכם פרופיל?' })).toBeVisible()
  })

  test('the private edit link opens the profile in another browser and disappears from the address bar', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const me = await claimByApi(page)
    await signIn(page, me)
    await page.goto('/me')
    const link = await page.getByLabel('קישור עריכה פרטי').inputValue()
    expect(new URL(link).pathname).toBe(`/me/${me.token}`)

    const other = await anotherUser()
    await login(other, 'member')
    await other.goto(new URL(link).pathname)
    await expect(other).toHaveURL(/\/me$/)
    await closeWelcome(other)
    await expect(other.getByLabel('שם', { exact: true })).toHaveValue(me.name)

    // A link the server does not know says so and leaves the join page.
    const stale = await anotherUser()
    await login(stale, 'member')
    await stale.goto('/me/not-a-real-link')
    await expect(stale.getByText('קישור העריכה כבר לא בתוקף. בקשו מאחד המארגנים לאפס את הפרופיל.')).toBeVisible()
    await expect(stale.getByRole('heading', { name: 'לא מופיעים באף תמונה?' })).toBeVisible()
  })
})

test.describe('joining and leaving', () => {
  test('someone missing from every photo adds themself and then shows up in the friends grid', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const taken = await aDemoClaimed(page)
    await page.goto('/me')

    const nameField = page.getByLabel('השם שלך')
    const create = page.getByRole('button', { name: 'יצירת הפרופיל שלי' })
    await expect(create).toBeDisabled()
    // A name that a claimed profile already has gets a hint to sign in instead.
    await nameField.fill(taken.name)
    await expect(page.getByText(`כבר יש פרופיל בשם ${taken.name}.`)).toBeVisible()
    await nameField.fill('Zed Latecomer')
    await expect(page.getByText('כבר יש פרופיל בשם')).toHaveCount(0)
    await page.getByLabel('בחרו קוד אישי').fill('abc')
    await expect(create).toBeDisabled()
    await page.getByLabel('בחרו קוד אישי').fill(PIN)
    await create.click()

    await closeWelcome(page)
    await expect(page.getByLabel('שם', { exact: true })).toHaveValue('Zed Latecomer')
    await expect(page.getByText('יש לכם קוד אישי.')).toBeVisible()

    const bob = await anotherUser()
    await login(bob, 'member')
    await bob.goto('/friends')
    await bob.getByLabel('חיפוש בוגרים לפי שם').fill('Latecomer')
    await bob.getByRole('button', { name: /Zed Latecomer/ }).click()
    await expect(bob.getByRole('dialog').getByRole('heading', { name: 'Zed Latecomer' })).toBeVisible()
    await expect(bob.getByRole('button', { name: 'זה הפרופיל שלי. כניסה עם הקוד האישי' })).toBeVisible()
  })

  test('removing my info keeps the name, wipes the rest, and lets the profile be claimed again', async ({ page, anotherUser }) => {
    await login(page, 'member')
    const me = await claimByApi(page, { email: 'leaving@example.com' })
    await page.request.patch('/api/me', { headers: { 'x-edit-token': me.token }, data: { city: 'Goneville, NV', bio: 'About to leave', quote: 'Bye!', attending: 'yes' } })
    await signIn(page, me)
    await page.goto('/me')
    await expect(page.getByLabel('איפה גרים היום?')).toHaveValue('Goneville, NV')

    await page.getByRole('button', { name: 'הסרת הפרטים שלי' }).click()
    const confirm = page.getByRole('alertdialog', { name: 'אישור הסרה' })
    await expect(confirm).toContainText('השם יישאר על תמונות המחזור')
    await confirm.getByRole('button', { name: 'להשאיר' }).click()
    await expect(confirm).toBeHidden()
    await expect(page.getByLabel('איפה גרים היום?')).toHaveValue('Goneville, NV')

    await page.getByRole('button', { name: 'הסרת הפרטים שלי' }).click()
    await page.getByRole('button', { name: 'כן, להסיר' }).click()
    await expect(page).toHaveURL(/\/$/)
    await page.goto('/me')
    await expect(page.getByRole('heading', { name: 'לא מופיעים באף תמונה?' })).toBeVisible()

    // Server side: the name stays, the details and the claim are gone, and the old key stops working.
    const after = (await roster(page)).find((p) => p.id === me.id)!
    expect(after).toMatchObject({ name: me.name, claimed: false, city: null, bio: null })
    const stale = await page.request.get('/api/me', { headers: { 'x-edit-token': me.token } })
    expect(stale.status()).toBe(403)

    // Anyone can claim it again, and it starts empty.
    const bob = await anotherUser()
    await login(bob, 'member')
    await bob.goto(`/p/${me.id}`)
    await expect(bob.getByRole('heading', { name: me.name })).toBeVisible()
    await expect(bob.getByText('Goneville, NV')).toHaveCount(0)
    await expect(bob.getByText('אף אחד עדיין לא לקח בעלות על הפרופיל הזה.')).toBeVisible()
    await bob.getByRole('button', { name: 'זה הפרופיל שלי! אני רוצה לערוך אותו' }).click()
    await bob.getByLabel('בחרו קוד אישי').fill('second-owner-1')
    await bob.getByRole('button', { name: 'זה הפרופיל שלי', exact: true }).click()
    await expect(bob).toHaveURL(/\/me\?welcome=1$/)
    await closeWelcome(bob)
    await expect(bob.getByLabel('שם', { exact: true })).toHaveValue(me.name)
    await expect(bob.getByLabel('איפה גרים היום?')).toHaveValue('')
  })
})
