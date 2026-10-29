// The Changes view opened as an editor tab (changes.html, dev/harness/changesShim.ts): the page the
// Log's details area shares its markup with, but without the Log's bundle (no branch sheet).
import { expect, test } from "@playwright/test";

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`its details heading names the commit alone, in ${theme}, without console errors`, async ({ page }) => {
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(`/changes.html?theme=${theme}`);
    await expect(page.locator(".detail-heading-commit")).toBeVisible();
    await expect(page.locator(".detail-heading-branch")).toBeHidden();
    // "Commit Details", never "Commit DetailsBranch": the heading reads as one name.
    const heading = await page.locator(".detail-heading-commit").evaluate((el) => el.closest("#detail-heading, .detail-heading, h2, h3")?.innerText ?? el.innerText);
    expect(heading.trim()).not.toMatch(/Branch$/);
    expect(errors).toEqual([]);
  });
}
