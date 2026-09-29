import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { expect, login, test } from './fixtures.ts'

type Page = Parameters<typeof login>[0]

interface PersonRow {
  id: number
  name: string
  formerName: string | null
  nickname: string | null
  email: string | null
  phone: string | null
  claimed: boolean
  gender: 'm' | 'f' | null
  inMemoriam: boolean
}
interface TagRow {
  id: number
  sceneId: number
  personId: number | null
  x: number
  y: number
  w: number
  h: number
  staff: boolean
}
interface SceneRow {
  id: number
  slug: string
  title: string
  kind: 'group' | 'mosaic'
  tags: TagRow[]
}

// Every test in this file shares one server, and --repeat-each reruns them on it, so what a test creates gets a
// unique digit suffix (nameKey ignores digits, so duplicate detection still sees the letters) and is removed after.
let counter = 0
const suffix = () => `${String(Date.now()).slice(-7)}${counter++}`

async function openAdmin(page: Page, tab?: 'סקירה' | 'אנשים' | 'רשימת הכיתות' | 'תמונות') {
  await login(page, 'admin')
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'חדר המנהל' })).toBeVisible()
  if (tab) await page.getByRole('navigation', { name: 'אזורי הניהול' }).getByRole('button', { name: tab, exact: true }).click()
}

const getPeople = async (page: Page): Promise<PersonRow[]> => (await page.request.get('/api/people')).json()
const getScenes = async (page: Page): Promise<SceneRow[]> => (await page.request.get('/api/admin/scenes')).json()

async function addPerson(page: Page, fields: Record<string, unknown>): Promise<PersonRow> {
  const res = await page.request.post('/api/admin/people', { data: fields })
  expect(res.status()).toBe(201)
  return res.json()
}

async function removePerson(page: Page, id: number) {
  expect((await page.request.delete(`/api/admin/people/${id}`)).ok()).toBe(true)
}

const groupImage = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#88aacc' } }).jpeg().toBuffer()

async function addScene(page: Page, title: string): Promise<SceneRow> {
  const res = await page.request.post('/api/admin/scenes', {
    multipart: { title, image: { name: 'group.jpg', mimeType: 'image/jpeg', buffer: await groupImage(1200, 800) } },
  })
  expect(res.status()).toBe(201)
  return res.json()
}

async function addTag(page: Page, sceneId: number, personId: number | null, x: number): Promise<TagRow> {
  const res = await page.request.post(`/api/admin/scenes/${sceneId}/tags`, { data: { x, y: 100, w: 80, h: 100, personId } })
  expect(res.status()).toBe(201)
  return res.json()
}

const memberOf = async (anotherUser: () => Promise<Page>) => {
  const member = await anotherUser()
  await login(member, 'member')
  return member
}

/** The row of the people list, the scene list or the feedback inbox that holds this text. */
const rowOf = (page: Page, text: string) => page.getByRole('listitem').filter({ hasText: text })

test.describe('access and overview', () => {
  test('the admin tab opens the admin page with its sections', async ({ page }) => {
    await login(page, 'admin')
    await page.goto('/')
    await page.getByRole('link', { name: 'חדר המנהל' }).click()
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.getByRole('heading', { name: 'חדר המנהל' })).toBeVisible()
    const sections = page.getByRole('navigation', { name: 'אזורי הניהול' })
    for (const name of ['סקירה', 'אנשים', 'רשימת הכיתות', 'תמונות']) await expect(sections.getByRole('button', { name, exact: true })).toBeVisible()
    await expect(sections.getByRole('link', { name: 'מיתוג' })).toBeVisible()
    await expect(sections.getByRole('button', { name: 'סקירה', exact: true })).toHaveAttribute('aria-pressed', 'true')

    await sections.getByRole('button', { name: 'אנשים', exact: true }).click()
    await expect(page.getByLabel('חיפוש ברשימה')).toBeVisible()
    await expect(sections.getByRole('button', { name: 'אנשים', exact: true })).toHaveAttribute('aria-pressed', 'true')
  })

  test('a member at /admin sees the yearbook, and the admin API refuses them', async ({ page }) => {
    await login(page, 'member')
    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: 'חדר המנהל' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'חדר המנהל' })).toHaveCount(0)
    await expect(page.getByText(/\d+\/\d+ זוהו/)).toBeVisible()

    for (const path of ['/api/admin/stats', '/api/admin/feedback', '/api/admin/export', '/api/admin/scenes']) {
      const res = await page.request.get(path)
      expect(res.status(), path).toBe(403)
      expect(await res.json()).toEqual({ error: 'למארגנים בלבד' })
    }
    expect((await page.request.post('/api/admin/people', { data: { name: 'Sneaky Member' } })).status()).toBe(403)
    expect((await page.request.delete('/api/admin/people/1')).status()).toBe(403)
  })

  test('the overview shows the version and the numbers the server counts', async ({ page }) => {
    await openAdmin(page)
    const stats = await (await page.request.get('/api/admin/stats')).json()
    await expect(page.getByText('גרסה מקומית')).toBeVisible()

    const tile = (label: string) => page.getByRole('button', { name: new RegExp(`^${label}`) })
    await expect(tile('בוגרים ברשימה')).toContainText(String(stats.people))
    await expect(tile('לקחו בעלות על פרופיל')).toContainText(String(stats.claimed))
    await expect(tile('פנים שזוהו')).toContainText(`${stats.facesNamed}/${stats.faces}`)
    await expect(tile('מגיעים')).toContainText(`אולי ${stats.attending.maybe}, לא ${stats.attending.no}`)
    await expect(page.getByText('פתקים שנשלחו').locator('..')).toContainText(String(stats.notes))

    // A tile with a list behind it opens the list, and again closes it.
    await tile('לקחו בעלות על פרופיל').click()
    await expect(page.getByRole('heading', { name: `לקחו בעלות על פרופיל (${stats.claimed})` })).toBeVisible()
    await tile('פנים שזוהו').click()
    await expect(page.getByRole('heading', { name: `פנים בלי שם (${stats.faces - stats.facesNamed})` })).toBeVisible()
    await tile('פנים שזוהו').click()
    await expect(page.getByRole('heading', { name: /^פנים בלי שם/ })).toHaveCount(0)

    // The people tile leads to the people list.
    await tile('בוגרים ברשימה').click()
    await expect(page.getByRole('heading', { name: `אנשים (${stats.people})` })).toBeVisible()
  })
})

test.describe('people', () => {
  test('the search finds people by name, nickname or former name', async ({ page }) => {
    const people = await (async () => {
      await login(page, 'admin')
      return getPeople(page)
    })()
    const withNickname = people.find((p) => p.nickname)!
    const withFormer = people.find((p) => p.formerName)!
    await openAdmin(page, 'אנשים')
    const search = page.getByPlaceholder('שם, כינוי או שם קודם')
    const haystack = (p: PersonRow) => [p.name, p.formerName, p.nickname].filter(Boolean).join(' ').toLowerCase()

    for (const query of [withNickname.nickname!, withFormer.formerName!, withNickname.name]) {
      await search.fill(query)
      const expected = people.filter((p) => query.toLowerCase().split(/\s+/).every((w) => haystack(p).includes(w)))
      expect(expected.length).toBeGreaterThan(0)
      await expect(page.getByRole('listitem')).toHaveCount(expected.length)
      for (const p of expected.slice(0, 3)) await expect(rowOf(page, p.name).first()).toBeVisible()
    }

    await search.fill('zzzz-nobody')
    await expect(page.getByRole('listitem')).toHaveCount(0)
    await search.clear()
    await expect(page.getByRole('listitem')).toHaveCount(people.length)
  })

  test('an organizer adds a person, renames them, and deletes them', async ({ page, anotherUser }) => {
    const sfx = suffix()
    const name = `Added Person ${sfx}`
    const renamed = `Renamed Person ${sfx}`
    await openAdmin(page, 'אנשים')

    await page.getByLabel('הוספת אדם לרשימה').fill(name)
    await page.getByRole('button', { name: 'הוספה', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('בוצע.')
    await page.getByPlaceholder('שם, כינוי או שם קודם').fill(sfx)
    await expect(rowOf(page, name)).toContainText('ללא בעלות')

    // Members see the new person in the friends list.
    const member = await memberOf(anotherUser)
    await member.goto('/friends')
    await member.getByLabel('חיפוש בוגרים לפי שם').fill(sfx)
    await expect(member.getByText(name)).toBeVisible()

    await rowOf(page, name).getByRole('button', { name: 'עריכת השם' }).click()
    await page.getByLabel(`שם של ${name}`).fill(renamed)
    await page.getByRole('button', { name: 'שמירה' }).click()
    await expect(page.getByRole('status')).toHaveText(`השם עודכן ל"${renamed}".`)
    await expect(rowOf(page, renamed)).toBeVisible()
    await expect(rowOf(page, name)).toHaveCount(0)

    // The organizers' form only renames; the other details of a profile go through the same endpoint.
    const person = (await getPeople(page)).find((p) => p.name === renamed)!
    const patched = await page.request.patch(`/api/admin/people/${person.id}`, { data: { nickname: `Nick${sfx}`, city: 'Haifa' } })
    expect(patched.ok()).toBe(true)
    await page.reload()
    await page.getByRole('navigation', { name: 'אזורי הניהול' }).getByRole('button', { name: 'אנשים', exact: true }).click()
    await page.getByPlaceholder('שם, כינוי או שם קודם').fill(`Nick${sfx}`)
    await expect(rowOf(page, renamed)).toBeVisible()
    await expect(page.getByRole('listitem')).toHaveCount(1)

    await rowOf(page, renamed).getByRole('button', { name: 'מחיקה' }).click()
    await rowOf(page, renamed).getByRole('button', { name: 'ביטול' }).click()
    await expect(rowOf(page, renamed)).toBeVisible()
    await rowOf(page, renamed).getByRole('button', { name: 'מחיקה' }).click()
    await rowOf(page, renamed).getByRole('button', { name: 'למחוק באמת' }).click()
    await expect(rowOf(page, renamed)).toHaveCount(0)
    expect((await getPeople(page)).some((p) => p.id === person.id)).toBe(false)
  })

  test('resetting a claim frees the profile and voids the old edit link', async ({ page }) => {
    const name = `Claimed Person ${suffix()}`
    await login(page, 'admin')
    const person = await addPerson(page, { name })
    const claim = await page.request.post(`/api/people/${person.id}/claim`, { data: {} })
    expect(claim.ok()).toBe(true)
    const { token } = await claim.json()
    expect((await page.request.get('/api/me', { headers: { 'x-edit-token': token } })).ok()).toBe(true)

    await openAdmin(page, 'אנשים')
    await page.getByPlaceholder('שם, כינוי או שם קודם').fill(name)
    await expect(rowOf(page, name)).toContainText('בבעלות')
    await rowOf(page, name).getByRole('button', { name: 'איפוס בעלות' }).click()
    await rowOf(page, name).getByRole('button', { name: 'לאפס' }).click()
    await expect(page.getByRole('status')).toHaveText('הבעלות אופסה. קישור העריכה הישן כבר לא עובד.')
    await expect(rowOf(page, name)).toContainText('ללא בעלות')
    await expect(rowOf(page, name).getByRole('button', { name: 'איפוס בעלות' })).toHaveCount(0)

    expect((await page.request.get('/api/me', { headers: { 'x-edit-token': token } })).ok()).toBe(false)
    expect((await getPeople(page)).find((p) => p.id === person.id)!.claimed).toBe(false)
    await removePerson(page, person.id)
  })

  test('an organizer makes a one-time sign-in link for a claimed profile', async ({ page, server }) => {
    await login(page, 'admin')
    const claimed = (await getPeople(page)).find((p) => p.claimed)!
    await openAdmin(page, 'אנשים')
    await page.getByPlaceholder('שם, כינוי או שם קודם').fill(claimed.name)
    const row = rowOf(page, claimed.name).filter({ has: page.getByText(claimed.name, { exact: true }) })
    await expect(row).toHaveCount(1)
    await row.getByRole('button', { name: 'צרו קישור כניסה' }).click()

    const link = row.getByLabel(`קישור כניסה של ${claimed.name}`)
    await expect(link).toHaveValue(new RegExp(`^${server.url}/`))
    await expect(link).toHaveJSProperty('readOnly', true)
    await expect(row.getByText('הקישור עובד פעם אחת ותקף 30 דקות. שלחו אותו רק למי שהפרופיל שלו.')).toBeVisible()
    await expect(row.getByRole('button', { name: 'העתקה' })).toBeVisible()

    // An unclaimed profile has no such button.
    const unclaimed = (await getPeople(page)).find((p) => !p.claimed)!
    await page.getByPlaceholder('שם, כינוי או שם קודם').fill(unclaimed.name)
    await expect(rowOf(page, unclaimed.name).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'צרו קישור כניסה' })).toHaveCount(0)
  })

  test('a CSV import adds the new names, reads y and no as flags, and skips the rest', async ({ page, anotherUser }) => {
    const sfx = suffix()
    const hidden = `Csv Hidden ${sfx}`
    const shown = `Csv Shown ${sfx}`
    const bad = `Csv Bad ${sfx}`
    await login(page, 'admin')
    const existing = (await getPeople(page))[0].name
    const csv = [
      'name,nickname,email,show_email,phone,show_phone,in_memoriam',
      `${hidden},Hid,hid${sfx}@example.com,no,050-1234567,y,`,
      `${shown},,shown${sfx}@example.com,y,050-7654321,no,yes`,
      `${existing},,,,,,`,
      `${bad},,not-an-email,,,,`,
    ].join('\n')

    await openAdmin(page, 'אנשים')
    await page.getByText('ייבוא רשימה מקובץ CSV').click()
    await page.getByLabel('בחירת קובץ CSV').setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await expect(page.getByPlaceholder(/name,former_name,city/)).toHaveValue(csv)
    await page.getByRole('button', { name: 'ייבוא', exact: true }).click()

    await expect(page.getByRole('status')).toHaveText(`נוספו 2. דולגו: שורה 4: ${existing} כבר ברשימה; שורה 5: כתובת האימייל לא תקינה`)
    await page.getByPlaceholder('שם, כינוי או שם קודם').fill(sfx)
    await expect(rowOf(page, hidden)).toContainText(`hid${sfx}@example.com`)
    await expect(rowOf(page, shown)).toBeVisible()
    await expect(rowOf(page, bad)).toHaveCount(0)

    // The flags decide what classmates see: the email is hidden on the first row, the phone on the second.
    const member = await memberOf(anotherUser)
    const seen = (await getPeople(member)).filter((p) => p.name.endsWith(sfx))
    const first = seen.find((p) => p.name === hidden)!
    const second = seen.find((p) => p.name === shown)!
    expect(seen).toHaveLength(2)
    expect(first).toMatchObject({ nickname: 'Hid', email: null, phone: '050-1234567', inMemoriam: false })
    expect(second).toMatchObject({ email: `shown${sfx}@example.com`, phone: null, inMemoriam: true })

    // Uploading the same list again adds nobody.
    await page.getByLabel('בחירת קובץ CSV').setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await page.getByRole('button', { name: 'ייבוא', exact: true }).click()
    await expect(page.getByRole('status')).toContainText(`נוספו 0. דולגו: שורה 2: ${hidden} כבר ברשימה; שורה 3: ${shown} כבר ברשימה`)

    await removePerson(page, first.id)
    await removePerson(page, second.id)
  })
})

test.describe('roster', () => {
  test('two spellings of one person are merged from the duplicates view', async ({ page }) => {
    const sfx = suffix()
    const from = `Zelda Quimbie ${sfx}`
    const into = `Zelda Quimby ${sfx}`
    await login(page, 'admin')
    const other = await addScene(page, `Merge Scene ${sfx}`)
    const demo = (await getScenes(page)).find((s) => s.kind === 'group' && s.id !== other.id)!
    const a = await addPerson(page, { name: from, nickname: `Quim${sfx}`, email: `zelda${sfx}@example.com` })
    const b = await addPerson(page, { name: into })
    const tagA = await addTag(page, other.id, a.id, 100)
    const tagB = await addTag(page, demo.id, b.id, 4000)

    await openAdmin(page, 'רשימת הכיתות')
    await page.getByRole('navigation', { name: 'כלי הרשימה' }).getByRole('button', { name: /^כפילויות/ }).click()
    const pair = rowOf(page, from).filter({ hasText: into })
    await expect(pair).toHaveCount(1)
    await pair.getByRole('button', { name: 'אותו אדם, לאחד' }).click()
    await expect(pair).toHaveCount(0)

    // The merged-away profile is gone; the kept one has its details and both faces.
    const people = await getPeople(page)
    expect(people.some((p) => p.id === a.id)).toBe(false)
    expect(people.find((p) => p.id === b.id)).toMatchObject({ nickname: `Quim${sfx}`, email: `zelda${sfx}@example.com` })
    const tags = (await getScenes(page)).flatMap((s) => s.tags)
    expect(tags.find((t) => t.id === tagA.id)!.personId).toBe(b.id)
    expect(tags.find((t) => t.id === tagB.id)!.personId).toBe(b.id)

    await page.request.delete(`/api/admin/tags/${tagB.id}`)
    await removePerson(page, b.id)
    expect((await page.request.delete(`/api/admin/scenes/${other.id}`)).ok()).toBe(true)
  })

  test('people who might be the same person can be dismissed', async ({ page }) => {
    const sfx = suffix()
    const first = `Yolanda Pemberton ${sfx}`
    const second = `Yolanda Pemberten ${sfx}`
    await login(page, 'admin')
    const other = await addScene(page, `Dismiss Scene ${sfx}`)
    const demo = (await getScenes(page)).find((s) => s.kind === 'group' && s.id !== other.id)!
    const a = await addPerson(page, { name: first })
    const b = await addPerson(page, { name: second })
    await addTag(page, other.id, a.id, 100)
    const tagB = await addTag(page, demo.id, b.id, 4000)

    await openAdmin(page, 'רשימת הכיתות')
    await page.getByRole('navigation', { name: 'כלי הרשימה' }).getByRole('button', { name: /^כפילויות/ }).click()
    const pair = rowOf(page, first).filter({ hasText: second })
    await expect(pair).toHaveCount(1)
    await pair.getByRole('button', { name: 'אנשים שונים' }).click()
    await expect(pair).toHaveCount(0)
    // Both are still there.
    expect((await getPeople(page)).filter((p) => [a.id, b.id].includes(p.id))).toHaveLength(2)

    await page.request.delete(`/api/admin/tags/${tagB.id}`)
    await removePerson(page, a.id)
    await removePerson(page, b.id)
    await page.request.delete(`/api/admin/scenes/${other.id}`)
  })

  test('G, B and the arrow keys answer the review one by one', async ({ page }) => {
    await openAdmin(page, 'רשימת הכיתות')
    const nameField = page.getByLabel('שם (אפשר להשלים שם פרטי)')
    const counter = page.getByText(/^\d+\/\d+$/)
    const reviewCount = page.getByRole('navigation', { name: 'כלי הרשימה' }).getByRole('button', { name: /^אחד אחד/ })
    await expect(counter).toBeVisible()
    const [position, total] = ((await counter.textContent()) ?? '').split('/').map(Number)
    expect(position).toBe(1)
    await expect(reviewCount).toHaveText(`אחד אחד (${total})`)

    const firstName = await nameField.inputValue()
    await page.keyboard.press('g')
    await expect(counter).toHaveText(`2/${total}`)
    const secondName = await nameField.inputValue()
    expect(secondName).not.toBe(firstName)
    await page.keyboard.press('b')
    await expect(counter).toHaveText(`3/${total}`)

    const people = await getPeople(page)
    expect(people.find((p) => p.name === firstName)!.gender).toBe('f')
    expect(people.find((p) => p.name === secondName)!.gender).toBe('m')
    await expect(reviewCount).toHaveText(`אחד אחד (${total - 2})`)

    // In this right-to-left page the right arrow goes back and the left arrow goes on.
    await page.keyboard.press('ArrowRight')
    await expect(counter).toHaveText(`2/${total}`)
    await expect(nameField).toHaveValue(secondName)
    await page.keyboard.press('ArrowRight')
    await expect(counter).toHaveText(`1/${total}`)
    await expect(nameField).toHaveValue(firstName)
    await page.keyboard.press('ArrowLeft')
    await expect(counter).toHaveText(`2/${total}`)

    // Answering again changes the answer.
    await page.keyboard.press('ArrowRight')
    await expect(nameField).toHaveValue(firstName)
    await page.keyboard.press('b')
    await expect(counter).toHaveText(`2/${total}`)
    expect((await getPeople(page)).find((p) => p.name === firstName)!.gender).toBe('m')
  })

  test('an unnamed face gets a profile, and a face can be marked as staff and restored', async ({ page }) => {
    const name = `Unnamed Face ${suffix()}`
    await openAdmin(page, 'רשימת הכיתות')
    const tools = page.getByRole('navigation', { name: 'כלי הרשימה' })
    const faces = (await getScenes(page)).filter((s) => s.kind === 'group').flatMap((s) => s.tags)
    const unnamed = faces.filter((t) => !t.staff && t.personId == null).length
    const staff = faces.filter((t) => t.staff).length
    expect(unnamed).toBeGreaterThan(1)
    await expect(tools.getByRole('button', { name: /^בלי שם/ })).toHaveText(`בלי שם (${unnamed})`)

    await tools.getByRole('button', { name: /^בלי שם/ }).click()
    await page.getByPlaceholder('שם', { exact: true }).first().fill(name)
    await page.getByRole('button', { name: 'יצירת פרופיל' }).first().click()
    await expect(tools.getByRole('button', { name: /^בלי שם/ })).toHaveText(`בלי שם (${unnamed - 1})`)
    const created = (await getPeople(page)).find((p) => p.name === name)!
    expect(created).toBeTruthy()

    await page.getByRole('button', { name: 'צוות / לא פנים' }).first().click()
    await expect(tools.getByRole('button', { name: /^בלי שם/ })).toHaveText(`בלי שם (${unnamed - 2})`)
    await expect(tools.getByRole('button', { name: /^צוות/ })).toHaveText(`צוות (${staff + 1})`)

    // Staff faces leave the yearbook's count of faces, and can come back.
    await tools.getByRole('button', { name: /^צוות/ }).click()
    await expect(page.getByRole('button', { name: 'זה תלמיד, להחזיר' })).toHaveCount(staff + 1)
    await page.getByRole('button', { name: 'זה תלמיד, להחזיר' }).first().click()
    await expect(tools.getByRole('button', { name: /^צוות/ })).toHaveText(`צוות (${staff})`)
    await expect(tools.getByRole('button', { name: /^בלי שם/ })).toHaveText(`בלי שם (${unnamed - 1})`)

    // Deleting the new profile leaves its face unnamed again.
    await removePerson(page, created.id)
    await page.reload()
    await page.getByRole('navigation', { name: 'אזורי הניהול' }).getByRole('button', { name: 'רשימת הכיתות', exact: true }).click()
    await expect(tools.getByRole('button', { name: /^בלי שם/ })).toHaveText(`בלי שם (${unnamed})`)
  })

  test('the roster file downloads and uploads back without changing anything', async ({ page }) => {
    await openAdmin(page, 'רשימת הכיתות')
    await page.getByRole('navigation', { name: 'כלי הרשימה' }).getByRole('button', { name: 'ייבוא וייצוא' }).click()
    const download = page.waitForEvent('download')
    await page.getByRole('link', { name: 'הורדת קובץ הרשימה' }).click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/^reunion-roster-\d{4}-\d\d-\d\d\.json$/)
    const roster = JSON.parse(await readFile((await file.path())!, 'utf8'))
    const faces = roster.scenes.flatMap((s: { faces: { person: string | null }[] }) => s.faces)
    expect(faces.length).toBeGreaterThan(0)
    const named = faces.filter((f: { person: string | null }) => f.person).length

    await page.getByLabel('העלאת קובץ רשימה').setInputFiles({ name: 'roster.json', mimeType: 'application/json', buffer: await readFile((await file.path())!) })
    await expect(page.getByRole('status')).toHaveText(
      `${faces.length} פנים עודכנו, 0 פרופילים נוספו, 0 עודכנו. ${named} שמות קיימים נשמרו, 0 פנים מהקובץ לא נמצאו כאן.`,
    )
  })
})

test.describe.serial('a group photo from upload to delete', () => {
  const title = `E2E Group ${suffix()}`
  const boxPerson = `Boxed Person ${suffix()}`
  let personId = 0

  const tagger = async (page: Page) => {
    await openAdmin(page, 'תמונות')
    await rowOf(page, title).getByRole('button', { name: 'תיוג פנים' }).click()
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    await expect(page.getByRole('button', { name: 'זיהוי פנים אוטומטי' })).toBeEnabled()
  }
  const counter = (page: Page, faces: number, named: number) => expect(page.getByText(`${faces} פנים / ${named} זוהו`)).toBeVisible()
  // OpenSeadragon draws on a canvas with no accessible name, so the drag is aimed at its class.
  const canvasCenter = async (page: Page) => {
    const box = (await page.locator('.openseadragon-canvas').boundingBox())!
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }

  test('an uploaded group photo is listed and members can view it', async ({ page, anotherUser }) => {
    await openAdmin(page, 'תמונות')
    await page.getByLabel('כותרת (מופיעה בלשונית)').fill(title)
    await page.getByLabel('תמונה (עד 40MB)').setInputFiles({ name: 'group.jpg', mimeType: 'image/jpeg', buffer: await groupImage(1200, 800) })
    await page.getByRole('button', { name: 'הוספת תמונה' }).click()
    await expect(page.getByRole('status')).toHaveText('התמונה נוספה. פתחו את "תיוג פנים" כדי לזהות פנים ולהוסיף שמות.')
    await expect(rowOf(page, title)).toContainText('1200x800, 0 פנים, 0 זוהו')
    await expect(page.getByLabel('כותרת (מופיעה בלשונית)')).toHaveValue('')

    const scene = (await getScenes(page)).find((s) => s.title === title)!
    expect(scene.kind).toBe('group')
    const member = await memberOf(anotherUser)
    await member.goto('/')
    await member.getByRole('button', { name: title, exact: true }).click()
    await expect(member).toHaveURL(new RegExp(`\\?s=${scene.slug}$`))
    await expect(member.getByRole('button', { name: title, exact: true })).toBeVisible()
  })

  test('auto-detect says so when the face model cannot load', async ({ page }) => {
    await tagger(page)
    await counter(page, 0, 0)
    await page.getByRole('button', { name: 'זיהוי פנים אוטומטי' }).click()
    await expect(page.getByText(/^זיהוי הפנים נכשל: /)).toBeVisible()
    // The button is usable again and nothing was added.
    await expect(page.getByRole('button', { name: 'זיהוי פנים אוטומטי' })).toBeEnabled()
    await counter(page, 0, 0)
  })

  test('a box drawn by hand can be named, and members see it on the class photo', async ({ page, anotherUser }) => {
    await tagger(page)
    await page.getByRole('button', { name: 'ציור מסגרות' }).click()
    const { x, y } = await canvasCenter(page)
    // On a desktop a box is drawn by clicking one corner, moving, and clicking the opposite corner.
    await page.mouse.move(x - 60, y - 40)
    await page.mouse.click(x - 60, y - 40)
    await page.mouse.move(x, y, { steps: 5 })
    await page.mouse.move(x + 60, y + 40, { steps: 5 })
    await page.mouse.click(x + 60, y + 40)
    await counter(page, 1, 0)
    // A new box is not selected: switch to selecting and click it to give it a name.
    await page.getByRole('button', { name: 'הזזה / בחירה' }).click()
    await page.mouse.click(x, y)
    await expect(page.getByText('עדיין בלי שם')).toBeVisible()

    await page.getByPlaceholder('הקלידו שם...').fill(boxPerson)
    await page.getByRole('button', { name: `הוספת "${boxPerson}" כאדם חדש` }).click()
    await counter(page, 1, 1)
    personId = (await getPeople(page)).find((p) => p.name === boxPerson)!.id

    const scene = (await getScenes(page)).find((s) => s.title === title)!
    expect(scene.tags).toHaveLength(1)
    expect(scene.tags[0].personId).toBe(personId)

    const member = await memberOf(anotherUser)
    await member.goto('/')
    await member.getByRole('button', { name: title, exact: true }).click()
    await expect(member.getByRole('button', { name: boxPerson })).toHaveCount(1)
    await expect(member.getByText('1/1 זוהו')).toBeVisible()
  })

  test('a box can be moved and deleted', async ({ page }) => {
    await login(page, 'admin')
    const boxOf = async () => (await getScenes(page)).find((s) => s.title === title)!.tags[0]
    const before = await boxOf()
    await tagger(page)
    await counter(page, 1, 1)
    await page.getByRole('button', { name: 'הזזה / בחירה' }).click()
    const { x, y } = await canvasCenter(page)
    await page.mouse.click(x, y)
    await expect(page.getByText(boxPerson, { exact: true })).toBeVisible()

    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 40, y + 20, { steps: 8 })
    await page.mouse.up()
    // The move is saved when the box is let go of, by clicking on the picture outside it.
    await page.mouse.click(x - 300, y - 200)
    await expect
      .poll(async () => {
        const moved = await boxOf()
        return moved.x > before.x && moved.y > before.y && Math.round(moved.w) === Math.round(before.w) && Math.round(moved.h) === Math.round(before.h)
      })
      .toBe(true)

    await page.mouse.click(x + 40, y + 20)
    await page.getByRole('button', { name: 'הסרת השם' }).click()
    await counter(page, 1, 0)
    await page.getByRole('button', { name: 'מחיקת המסגרת' }).click()
    await counter(page, 0, 0)
    expect((await getScenes(page)).find((s) => s.title === title)!.tags).toHaveLength(0)
    await removePerson(page, personId)
  })

  test('a moved box is kept when the organizer leaves with Done', async ({ page }) => {
    test.fixme(true, 'a box dragged in the tagger is only saved once it is deselected; clicking סיום right after the drag loses the move')
    await login(page, 'admin')
    const scene = (await getScenes(page)).find((s) => s.title === title)!
    await tagger(page)
    await page.getByRole('button', { name: 'ציור מסגרות' }).click()
    const { x, y } = await canvasCenter(page)
    await page.mouse.move(x - 60, y - 40)
    await page.mouse.click(x - 60, y - 40)
    await page.mouse.move(x + 60, y + 40, { steps: 5 })
    await page.mouse.click(x + 60, y + 40)
    await counter(page, 1, 0)
    const drawn = (await getScenes(page)).find((s) => s.id === scene.id)!.tags[0]
    await page.getByRole('button', { name: 'הזזה / בחירה' }).click()
    await page.mouse.click(x, y)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 40, y + 20, { steps: 8 })
    await page.mouse.up()
    await page.getByRole('button', { name: 'סיום' }).click()
    await expect.poll(async () => (await getScenes(page)).find((s) => s.id === scene.id)!.tags[0].x).toBeGreaterThan(drawn.x)
    await page.request.delete(`/api/admin/tags/${drawn.id}`)
  })

  test('the wall is rebuilt from the profiles', async ({ page }) => {
    await login(page, 'admin')
    const wall = async () => (await getScenes(page)).filter((s) => s.kind === 'mosaic')
    const [before] = await wall()
    await openAdmin(page, 'תמונות')
    await page.getByRole('button', { name: 'בנייה מחדש של הקיר' }).click()
    await expect(page.getByRole('status')).toHaveText('הקיר נבנה מחדש.')
    await expect(page.getByRole('button', { name: 'בנייה מחדש של הקיר' })).toBeEnabled()
    const after = await wall()
    expect(after).toHaveLength(1)
    expect(after[0].id).not.toBe(before.id)
    expect(after[0].tags.length).toBe((await getPeople(page)).length)
  })

  test('the scene is deleted after asking twice', async ({ page, anotherUser }) => {
    await openAdmin(page, 'תמונות')
    const row = rowOf(page, title)
    await row.getByRole('button', { name: 'מחיקה' }).click()
    await row.getByRole('button', { name: 'ביטול' }).click()
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'מחיקה' }).click()
    await row.getByRole('button', { name: 'למחוק באמת' }).click()
    await expect(row).toHaveCount(0)
    expect((await getScenes(page)).some((s) => s.title === title)).toBe(false)

    const member = await memberOf(anotherUser)
    await member.goto('/')
    await expect(member.getByText(/\d+\/\d+ זוהו/)).toBeVisible()
    await expect(member.getByRole('button', { name: title, exact: true })).toHaveCount(0)
  })
})

test.describe('branding, feedback, backup and demo data', () => {
  test('a replacement emblem is served, and removing it brings the placeholder back', async ({ page, anotherUser }) => {
    await login(page, 'admin')
    const emblem = async () => {
      const res = await page.request.get('/branding/emblem.png')
      return { source: res.headers()['x-branding-source'], body: await res.body() }
    }
    expect((await emblem()).source).toBe('placeholder')

    await page.goto('/admin/branding')
    await expect(page.getByRole('heading', { name: 'מיתוג' })).toBeVisible()
    const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'הסמל בכותרת' }) })
    await expect(card.getByRole('button', { name: 'הסרה' })).toBeDisabled()

    const png = await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 0, g: 200, b: 0 } } }).png().toBuffer()
    await card.getByLabel('החלפה').setInputFiles({ name: 'emblem.png', mimeType: 'image/png', buffer: png })
    await expect(card.getByRole('status')).toHaveText('התמונה הוחלפה.')
    await expect(card.getByRole('button', { name: 'הסרה' })).toBeEnabled()

    // The server re-encodes what it gets, so the bytes are compared by picture, not by file.
    const served = await emblem()
    expect(served.source).toBe('upload')
    const decoded = await sharp(served.body).raw().toBuffer({ resolveWithObject: true })
    expect(decoded.info).toMatchObject({ width: 120, height: 80 })
    expect([...decoded.data.subarray(0, 3)]).toEqual([0, 200, 0])

    // A browser that has not seen the old emblem gets the new one in the header.
    const member = await memberOf(anotherUser)
    await member.goto('/')
    await expect.poll(() => member.locator('header img').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(120)

    await card.getByRole('button', { name: 'הסרה' }).click()
    await card.getByRole('button', { name: 'ביטול' }).click()
    await expect(card.getByRole('button', { name: 'הסרה' })).toBeEnabled()
    await card.getByRole('button', { name: 'הסרה' }).click()
    await card.getByRole('button', { name: 'להסיר באמת' }).click()
    await expect(card.getByRole('status')).toHaveText('הוסרה. מוצגת שוב התמונה הזמנית.')
    expect((await emblem()).source).toBe('placeholder')
    await expect(card.getByRole('button', { name: 'הסרה' })).toBeDisabled()
  })

  test('a file that is not an image is refused and the emblem stays', async ({ page }) => {
    await login(page, 'admin')
    await page.goto('/admin/branding')
    const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'הסמל בכותרת' }) })
    await card.getByLabel('החלפה').setInputFiles({ name: 'emblem.png', mimeType: 'image/png', buffer: Buffer.from('this is not a picture') })
    await expect(card.getByRole('alert')).toHaveText('הקובץ אינו תמונה תקינה')
    expect((await page.request.get('/branding/emblem.png')).headers()['x-branding-source']).toBe('placeholder')
  })

  test('feedback sent by a member reaches the inbox and can be deleted', async ({ page, anotherUser }) => {
    const sfx = suffix()
    const message = `The reunion page is great ${sfx}`
    const member = await memberOf(anotherUser)
    const sent = await member.request.post('/api/feedback', { data: { message, sender: `Bob ${sfx}` } })
    expect(sent.status()).toBe(201)

    await openAdmin(page)
    const count = async () => (await (await page.request.get('/api/admin/feedback')).json()).length
    const total = await count()
    await expect(page.getByRole('heading', { name: `משוב (${total})` })).toBeVisible()
    const row = rowOf(page, message)
    await expect(row).toContainText(`Bob ${sfx}`)
    await expect(row).toContainText('(לא נשלח במייל)')

    await row.getByRole('button', { name: 'מחיקה' }).click()
    await row.getByRole('button', { name: 'למחוק', exact: true }).click()
    await expect(row).toHaveCount(0)
    await expect(page.getByRole('heading', { name: `משוב (${total - 1})` })).toBeVisible()
    expect(await count()).toBe(total - 1)
  })

  test('the backup download holds the tables the page describes and no secrets', async ({ page }) => {
    await openAdmin(page)
    await expect(page.getByText(/קובץ JSON עם כל הפרופילים/)).toBeVisible()
    const download = page.waitForEvent('download')
    await page.getByRole('link', { name: 'הורדת גיבוי' }).click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/^reunion-backup-\d{4}-\d\d-\d\d\.json$/)
    const backup = JSON.parse(await readFile((await file.path())!, 'utf8'))

    for (const table of ['people', 'scenes', 'tags', 'person_photos', 'quotes', 'quote_comments', 'quote_reactions', 'tapes', 'videos', 'credits']) {
      expect(Array.isArray(backup[table]), table).toBe(true)
    }
    expect(backup.exportedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(backup.people).toHaveLength((await getPeople(page)).length)
    expect(backup.scenes.length).toBeGreaterThan(0)
    expect(backup.tags.length).toBeGreaterThan(0)
    expect(backup.person_photos.length).toBeGreaterThan(0)
    // Sign-in secrets are left out.
    expect(Object.keys(backup.people[0])).not.toContain('pin_hash')
    expect(Object.keys(backup.people[0])).not.toContain('edit_token_hash')
    expect(backup).not.toHaveProperty('notes')
    expect(backup).not.toHaveProperty('feedback')
  })

  test('loading demo data on a site that has people is refused and changes nothing', async ({ page }) => {
    await openAdmin(page, 'תמונות')
    // The button is only there while the site is empty.
    await expect(page.getByRole('button', { name: 'טעינת נתוני הדגמה' })).toHaveCount(0)
    const statsBefore = await (await page.request.get('/api/admin/stats')).json()

    const res = await page.request.post('/api/admin/demo')
    expect(res.status()).toBe(409)
    expect(await res.json()).toEqual({ error: 'אפשר לטעון נתוני הדגמה רק לאתר ריק, בלי אנשים ובלי תמונות מחזור' })
    expect(await (await page.request.get('/api/admin/stats')).json()).toEqual(statsBefore)
  })

  // The class passcode is set only through the CLASS_PASSCODE variable: the admin page and the API have no way to
  // change it, so there is nothing to click and no test for that journey.
})
