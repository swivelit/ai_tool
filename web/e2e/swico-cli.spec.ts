import { expect, test } from '@playwright/test'

test.describe('public Swico CLI guide', () => {
  test('scrolls the guide to its final section', async ({ page }) => {
    await page.goto('/swico-cli')
    const guide = page.locator('.cli-guide-page')
    const dimensions = await guide.evaluate(element => ({ scrollHeight:element.scrollHeight, clientHeight:element.clientHeight }))
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)
    await page.getByRole('link', { name:'Get started' }).focus()
    await page.keyboard.press('PageDown')
    await expect.poll(() => guide.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await page.getByRole('link', { name:'Current limitation' }).click()
    await expect(page.getByRole('heading', { name:'Current limitation' })).toBeVisible()
  })

  test('keeps the route public and returns guests to the guide after sign-in', async ({ page }) => {
    await page.goto('/swico-cli')
    const navigation = page.getByRole('navigation', { name:'Guide navigation' })
    await expect(navigation.getByRole('link', { name:'Sign in' })).toHaveAttribute('href', '/login?returnTo=%2Fswico-cli')
    await expect(page.getByRole('link', { name:'Current limitation' })).toBeVisible()
  })
})
