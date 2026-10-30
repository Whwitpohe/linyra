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

// The details' references (?refs=, dev/harness/changesShim.ts): the pills say where HEAD is, and
// "In N branches" lists only the branches the pills do not already name.
const details = (page) => page.locator("#commit-details .commit");
const parts = (pill) => pill.locator(".pill-part");

test("on the branch's tip: HEAD on the branch's pill, and no list repeating it", async ({ page }) => {
  await page.goto("/changes.html?refs=tip");
  const pills = details(page).locator(".commit-refs .pill");
  await expect(pills).toHaveCount(1);
  await expect(parts(pills.first())).toHaveText(["HEAD", "develop", "origin"]);
  await expect(pills.first().locator(".pill-part").first()).toHaveClass(/pill-head/);
  await expect(pills.first()).toHaveClass(/pill-current/);
  await expect(pills.first()).toHaveAttribute("title", "HEAD (checked out) · develop · origin/develop");
  await expect(details(page).locator(".containing-heading")).toHaveText("In no other branch.");
  await expect(details(page).locator(".branches-toggle, .containing-list")).toHaveCount(0);
  // Each branch is named once in the whole details.
  const names = await details(page).locator(".pill-label").allTextContents();
  expect(names).toEqual(["HEAD", "develop", "origin"]);
});

test("further on in other branches: only those are listed, a branch and its remote as one pill", async ({ page }) => {
  await page.goto("/changes.html");
  await expect(details(page).locator(".commit-refs .pill")).toHaveCount(2);
  await expect(parts(details(page).locator(".commit-refs .pill").first())).toHaveText(["HEAD", "develop", "origin"]);
  const heading = details(page).locator(".containing-heading");
  await expect(heading).toHaveText("Also in 2 other branches: Hide");
  const list = details(page).locator(".containing-list .pill");
  await expect(list).toHaveCount(1);
  await expect(parts(list.first())).toHaveText(["release-1.4", "origin"]);
  const above = await details(page).locator(".commit-refs .pill").evaluateAll((ps) => ps.map((p) => p.title));
  const listed = await list.evaluateAll((ps) => ps.map((p) => p.title));
  expect(listed.filter((t) => above.some((a) => a.split(" · ").some((n) => t.split(" · ").includes(n))))).toEqual([]);
  // The toggle hides the list and says so; the pills wrap in the pane like the ones above.
  const toggle = heading.locator(".branches-toggle");
  await toggle.click();
  await expect(details(page).locator(".containing-list")).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(details(page).locator(".containing-list")).toHaveCSS("display", "flex");
});

test("an older commit: every branch containing it, HEAD named on the checked-out one", async ({ page }) => {
  await page.goto("/changes.html?refs=old");
  await expect(details(page).locator(".commit-refs")).toHaveCount(0);
  await expect(details(page).locator(".containing-heading")).toHaveText("In 3 branches: Hide");
  await expect(details(page).locator(".containing-list .pill")).toHaveCount(2);
  await expect(parts(details(page).locator(".containing-list .pill").first())).toHaveText(["HEAD", "develop", "origin"]);
});

test("only a detached HEAD holds it: the HEAD pill alone, and in no branch", async ({ page }) => {
  await page.goto("/changes.html?refs=detached");
  const pills = details(page).locator(".commit-refs .pill");
  await expect(pills).toHaveCount(2);
  await expect(pills.first().locator(".pill-part")).toHaveClass(/pill-detached/);
  await expect(pills.first()).toHaveAttribute("title", "HEAD is detached");
  await expect(details(page).locator(".containing-heading")).toHaveText("Not in any branch.");
});

test("while the containing branches are read, no heading guesses at them", async ({ page }) => {
  await page.goto("/changes.html?refs=loading");
  await expect(details(page).locator(".commit-refs .pill")).toHaveCount(2);
  await expect(details(page).locator(".containing-branches")).toHaveCount(0);
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`the HEAD part reads in ${theme}: theme text, the muted icon, an outline in high contrast`, async ({ page }) => {
    await page.goto(`/changes.html?theme=${theme}`);
    const pill = details(page).locator(".commit-refs .pill").first();
    const look = await pill.evaluate((p) => {
      const head = p.querySelector(".pill-head"), style = getComputedStyle(head), root = getComputedStyle(document.body);
      return { color: style.color, icon: getComputedStyle(head.querySelector(".pill-icon")).color, outline: getComputedStyle(p).outlineStyle,
        fg: root.getPropertyValue("--vscode-foreground").trim(), muted: root.getPropertyValue("--vscode-descriptionForeground").trim() };
    });
    const rgb = (value) => page.evaluate((v) => { const el = document.createElement("i"); el.style.color = v; document.body.append(el); const c = getComputedStyle(el).color; el.remove(); return c; }, value);
    expect(look.color).toBe(await rgb(look.fg));
    expect(look.icon).toBe(await rgb(look.muted));
    if (theme.startsWith("hc")) expect(look.outline).toBe("solid");
  });
}
