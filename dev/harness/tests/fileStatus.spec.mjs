// One look for a changed file in every list of them (ui/fileStatus.css, ui/counts.css): the name in
// its status color and struck through when deleted, + always the add color and − the delete color,
// the status letter in its own column, a rename's old name muted. The Log's Changes view, Compare's
// sides and File History, in each theme.
import { expect, test } from "@playwright/test";

const colorOf = (l) => l.evaluate((el) => getComputedStyle(el).color);
const errorsOf = (page) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
};

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`Compare's side draws each file as the Changes view does, in ${theme}`, async ({ page }) => {
    const errors = errorsOf(page);
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.goto(`/repos.html?theme=${theme}&files=kinds`);
    const row = (name) => page.locator("#compare-left-tree .ftree-row", { has: page.locator(".ftree-label", { hasText: name }) });
    await expect(row("upload.ts")).toBeVisible();
    // + and − keep their own colors on a modified row (they used to take the row's).
    const modified = row("upload.ts");
    const add = modified.locator(".line-counts .count-added"), del = modified.locator(".line-counts .count-deleted");
    await expect(add).toHaveText("+12");
    await expect(del).toHaveText("−3");
    expect(await colorOf(add)).not.toBe(await colorOf(del));
    expect(await colorOf(add)).not.toBe(await colorOf(modified.locator(".ftree-label")));
    // The letter in its column, in the status color.
    await expect(modified.locator(".file-status > [aria-hidden]")).toHaveText("M");
    expect(await colorOf(modified.locator(".file-status"))).toBe(await colorOf(modified.locator(".ftree-label")));
    await expect(row("new-client.ts").locator(".file-status > [aria-hidden]")).toHaveText("A");
    // Deleted: struck through, D.
    const deleted = row("old-auth.ts");
    await expect(deleted.locator(".file-status > [aria-hidden]")).toHaveText("D");
    await expect(deleted.locator(".file-status")).toContainText("Deleted", { useInnerText: false });
    expect(await deleted.locator(".file-status-name").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    expect(await deleted.locator(".ftree-label").evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("line-through");
    expect(await row("upload.ts").locator(".ftree-label").evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
    // Renamed: R, the old name muted.
    const renamed = row("http-client.ts");
    await expect(renamed.locator(".file-status > [aria-hidden]")).toHaveText("R");
    await expect(renamed.locator(".ftree-old-path")).toHaveText("← src/http.ts");
    expect(await colorOf(renamed.locator(".ftree-old-path"))).not.toBe(await colorOf(renamed.locator(".ftree-label")));
    // Binary: no counts, the note instead.
    await expect(row("logo.png").locator(".line-counts")).toHaveCount(0);
    await expect(row("logo.png").locator(".ftree-note")).toHaveText("binary");
    // The letters line up in one column.
    const rights = await page.locator("#compare-left-tree .ftree-row .file-status").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().right)));
    expect(new Set(rights).size).toBe(1);
    expect(errors).toEqual([]);
  });
}

test("the Log's Changes view: the same letter, struck-through deleted names, + and − in their colors", async ({ page }) => {
  const errors = errorsOf(page);
  await page.setViewportSize({ width: 1400, height: 700 });
  await page.goto("/?theme=dark&avatars=off");
  await page.locator("#rows .row").first().click();
  const fileRow = page.locator("#changes-pane .ftree-row.status-M").first();
  await expect(fileRow.locator(".file-status > [aria-hidden]")).toHaveText("M");
  const add = fileRow.locator(".count-added"), del = fileRow.locator(".count-deleted");
  expect(await colorOf(add)).not.toBe(await colorOf(fileRow.locator(".ftree-label")));
  expect(await colorOf(add)).not.toBe(await colorOf(del));
  for (const status of ["A", "D", "R"]) {
    const r = page.locator(`#changes-pane .ftree-row.status-${status}`).first();
    if (await r.count() === 0) continue;
    await expect(r.locator(".file-status > [aria-hidden]")).toHaveText(status);
    expect(await r.locator(".ftree-label").evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe(status === "D" ? "line-through" : "none");
  }
  expect(errors).toEqual([]);
});
