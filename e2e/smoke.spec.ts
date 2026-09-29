import { expect, login, PASSCODES, test } from './fixtures.ts'

test('the gate lets a member in and the class photo shows its faces', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('סיסמה').fill(PASSCODES.member)
  await page.getByRole('button', { name: 'תנו לי להיכנס' }).click()

  // The demo class photo has tagged faces; each is a DOM overlay on top of the canvas.
  await expect(page.getByText('42/48 זוהו')).toBeVisible()
  const unknown = page.getByRole('button', { name: 'מי בתמונה?' })
  await expect(unknown).toHaveCount(6)
  await expect(unknown.first()).toBeVisible()
  // No accessible container holds just the faces (the scene and header buttons are buttons too), so count by class.
  await expect(page.locator('.face-tag')).toHaveCount(48)
})

test('another user is a separate browser that still sees the gate', async ({ page, anotherUser }) => {
  await login(page, 'member')
  const other = await anotherUser()
  await page.goto('/')
  await other.goto('/')
  await expect(page.getByLabel('סיסמה')).toHaveCount(0)
  await expect(page.getByText('42/48 זוהו')).toBeVisible()
  await expect(other.getByLabel('סיסמה')).toBeVisible()
})

test('an admin session shows the admin tab', async ({ page }) => {
  await login(page, 'admin')
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'חדר המנהל' })).toBeVisible()
})
