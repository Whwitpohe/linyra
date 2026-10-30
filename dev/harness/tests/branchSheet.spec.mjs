// The branch sheet (a branch pill's click) against the dev harness (dev/harness/mock/branchSheet.ts):
// its cards for each state of a local branch, a remote branch and a tag, its buttons, closing it,
// and its look in every theme and in a narrow Changes view.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", sheet = "", ai = "", across = "", width = 1500, height = 760, layout } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  if (layout) await page.addInitScript((l) => sessionStorage.setItem("linyra-layout", JSON.stringify(l)), layout);
  await page.goto(`/?theme=${theme}&avatars=off${sheet ? `&sheet=${sheet}` : ""}${ai ? `&ai=${ai}` : ""}${across ? `&across=${across}` : ""}`);
  await expect(page.locator("#rows .row").first()).toBeVisible();
  return errors;
};
const pill = (page, ref, repo = "/work/acme-web") => page.locator(`.row-ref .pill-part[data-repo="${repo}"][data-ref="${ref}"]`).first();
const sheet = (page) => page.locator("#branch-sheet");
const card = (page, title) => sheet(page).locator(".sheet-card", { has: page.locator(".card-title", { hasText: title }) });
const buttons = (locator) => locator.locator(".card-buttons .sheet-button, .sheet-button").allTextContents();
const sent = (page) => page.evaluate(() => window.harnessMessages.filter((m) => m.type === "branchSheet"));

test("a pill's click opens the branch's sheet in place of the commit details; Esc brings them back", async ({ page }) => {
  const errors = await open(page);
  await pill(page, "refs/heads/develop").click();
  await expect(sheet(page)).toBeVisible();
  await expect(page.locator("#commit-details")).toBeHidden();
  await expect(page.locator(".detail-heading-branch")).toBeVisible();
  await expect(sheet(page).locator(".sheet-name")).toHaveText("develop");
  await expect(sheet(page).locator(".sheet-badge")).toHaveText("checked out");
  await expect(sheet(page).locator(".sheet-repo")).toHaveText("acme-web");
  await expect(sheet(page).locator(".sheet-sha")).toHaveText("a42a50e");
  // Diverged from its upstream, behind its merge target with conflicts: one primary action, the first card's.
  const up = card(page, "Upstream");
  await expect(up.locator(".card-subject")).toHaveText("origin/develop");
  await expect(up.locator(".chip")).toHaveText("Diverged");
  await expect(up.locator(".card-status")).toHaveText("2 commits to push · 1 to pull.");
  expect(await buttons(up)).toEqual(["Pull", "Force Push…", "Fetch"]);
  const target = card(page, "Merges into");
  await expect(target.locator(".chip")).toHaveText("2 files conflict");
  await expect(target.locator(".card-hint")).toHaveText("Merging it in stops on them to resolve.");
  expect(await buttons(target)).toEqual(["Merge", "Rebase", "Review"]);
  await expect(sheet(page).locator(".sheet-button.primary")).toHaveCount(1);
  await expect(sheet(page).locator(".sheet-button.primary")).toHaveText("Pull");
  // A button asks the host for its command.
  await up.locator(".sheet-button", { hasText: "Fetch" }).click();
  await expect.poll(async () => (await sent(page)).map((m) => m.action)).toContain("fetch");
  expect((await sent(page)).find((m) => m.action === "fetch")).toMatchObject({ repoId: "/work/acme-web", ref: "refs/heads/develop" });
  await sheet(page).locator(".sheet-name").click();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator("#commit-details")).toBeVisible();
  await expect.poll(async () => (await sent(page)).map((m) => m.action)).toContain("close");
  expect(errors).toEqual([]);
});

test("the open sheet's branch is marked in the Log: its pills only, until the sheet closes", async ({ page }) => {
  for (const theme of ["dark", "hc-dark"]) {
    await open(page, { theme });
    await pill(page, "refs/heads/develop").click();
    await expect(sheet(page)).toBeVisible();
    const marked = page.locator('#rows .row-ref .pill-part[aria-current="true"]');
    await expect(marked.first()).toBeVisible();
    // Every marked part is develop's in acme-web; another branch's part (origin/develop beside it too) is not marked.
    const refs = await marked.evaluateAll((els) => els.map((el) => `${el.dataset.repo} ${el.dataset.ref}`));
    expect(new Set(refs)).toEqual(new Set(["/work/acme-web refs/heads/develop"]));
    await expect(page.locator('#rows .row-ref .pill-part[data-ref]:not([data-ref="refs/heads/develop"])[aria-current]')).toHaveCount(0);
    // Drawn in the focus border's color, inside the part (the pill clips anything outside).
    const style = await marked.first().evaluate((el) => {
      const s = getComputedStyle(el), probe = document.createElement("div");
      probe.style.color = "var(--vscode-focusBorder)";
      document.body.append(probe);
      const focus = getComputedStyle(probe).color;
      probe.remove();
      return { style: s.outlineStyle, color: s.outlineColor, offset: s.outlineOffset, focus };
    });
    expect(style).toEqual({ style: "solid", color: style.focus, offset: "-1px", focus: style.focus });
    await sheet(page).locator(".sheet-name").click();
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toBeHidden();
    await expect(page.locator("#rows .row-ref [aria-current]")).toHaveCount(0);
  }
});

test("selecting another row closes the sheet", async ({ page }) => {
  await open(page);
  await pill(page, "refs/heads/develop").click();
  await expect(sheet(page)).toBeVisible();
  await page.locator("#rows .row").nth(3).click();
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator("#commit-details")).toBeVisible();
  await expect(page.locator("#rows .row-ref [aria-current]")).toHaveCount(0);
});

const states = [
  ["ahead", { up: [null, "3 commits to push.", ["Push", "Fetch"]], target: [null, "4 commits not on origin/main.", ["Review"]] }],
  ["behind", { up: [null, "3 commits to pull.", ["Pull", "Fetch"]], target: ["No conflicts", "4 commits not on origin/main · 5 behind.", ["Merge", "Rebase", "Review"]] }],
  ["clean", { up: ["Up to date", "As of the last fetch.", ["Fetch"]] }],
  ["unpublished", { up: [null, "Not published.", ["Publish", "Set Upstream…"]] }],
  ["gone", { up: ["Gone", "Deleted on the remote.", ["Publish"]] }],
  ["unknown", { target: ["Conflicts unknown", "4 commits not on origin/main · 5 behind.", ["Merge", "Rebase", "Review"]] }],
];
for (const [state, want] of states) {
  test(`a local branch, ${state}: its cards say so`, async ({ page }) => {
    await open(page, { sheet: state });
    await pill(page, "refs/heads/develop").click();
    for (const [title, w] of [["Upstream", want.up], ["Merges into", want.target]]) {
      if (!w) continue;
      const c = card(page, title);
      const [chip, status, labels] = w;
      if (chip) await expect(c.locator(".chip")).toHaveText(chip); else await expect(c.locator(".chip")).toHaveCount(0);
      await expect(c.locator(".card-status")).toHaveText(status);
      expect(await buttons(c)).toEqual(labels);
    }
  });
}

test("a branch merged and not checked out: safe to delete, and no Switch (it would change nothing)", async ({ page }) => {
  await open(page, { sheet: "merged" });
  await pill(page, "refs/heads/develop").click();
  const target = card(page, "Merges into");
  await expect(target.locator(".chip")).toHaveText("Merged");
  await expect(target.locator(".card-hint")).toHaveText("Safe to delete.");
  expect(await buttons(target)).toEqual(["Delete Branch…"]);
  await expect(sheet(page).locator(".sheet-step", { hasText: "Switch" })).toHaveCount(0);
  await expect(sheet(page).locator(".sheet-badge")).toHaveCount(0);
});

test("an up-to-date, checked-out branch still has next steps, each with its icon and its command", async ({ page }) => {
  await open(page, { sheet: "clean" });
  await pill(page, "refs/heads/develop").click();
  const steps = sheet(page).locator(".sheet-step");
  await expect(steps.locator(".step-text")).toHaveText(["Show only its history in the Log", "Compare it with another branch", "Create a branch from it"]);
  expect(await steps.locator(".step-icon svg").count()).toBe(3);
  expect(await buttons(sheet(page).locator(".sheet-steps"))).toEqual(["Show History", "Compare…", "Create Branch…"]);
  await steps.locator(".sheet-button", { hasText: "Show History" }).click();
  await expect.poll(async () => (await sent(page)).map((m) => m.action)).toContain("history");
  await steps.locator(".sheet-button", { hasText: "Compare…" }).click();
  await expect.poll(async () => (await sent(page)).map((m) => m.action)).toContain("compareWith");
});

test("the upstream's and the merge target's names are links to their own sheets; the pencil changes the upstream", async ({ page }) => {
  await open(page);
  await pill(page, "refs/heads/develop").click();
  const upstream = card(page, "Upstream").locator("button.card-subject");
  await expect(upstream).toHaveText("origin/develop");
  expect(await upstream.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  const pencil = card(page, "Upstream").locator('button[data-action="setUpstream"]');
  await expect(pencil).toHaveAttribute("aria-label", "Change Upstream…");
  await pencil.click();
  await expect.poll(async () => (await sent(page)).map((m) => m.action)).toContain("setUpstream");
  await expect(card(page, "Merges into").locator("button.card-subject")).toHaveText("origin/main");
  // From the keyboard: the remote branch's sheet opens and takes the focus.
  await upstream.focus();
  await page.keyboard.press("Enter");
  await expect(sheet(page).locator(".sheet-name")).toHaveText("origin/develop");
  await expect(page.locator(".detail-heading-branch")).toHaveText("Remote Branch");
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("branch-sheet");
  expect((await sent(page)).filter((m) => m.action === "open").map((m) => m.ref)).toContain("refs/remotes/origin/develop");
});

test("a branch checked out in another worktree: Open it there, no Switch", async ({ page }) => {
  await open(page, { sheet: "worktree" });
  await pill(page, "refs/heads/develop").click();
  await expect(sheet(page).locator(".sheet-step").first()).toContainText("Checked out in worktree acme-web-hotfix");
  await expect(sheet(page).locator(".sheet-step", { hasText: "Switch to" })).toHaveCount(0);
});

test("a remote branch and a tag: no cards, their own next steps; AI off leaves Explain out", async ({ page }) => {
  await open(page, { ai: "off" });
  await pill(page, "refs/remotes/origin/release-1.4").click();
  await expect(sheet(page).locator(".sheet-name")).toHaveText("origin/release-1.4");
  await expect(sheet(page).locator(".sheet-card:not(.sheet-steps)")).toHaveCount(0);
  await expect(sheet(page).locator(".step-text")).toHaveText(["Check it out as a local branch", "Fetch it from its remote", "Review it against the checked-out branch", "Show only its history in the Log"]);
  await pill(page, "refs/tags/v1.4.0").click();
  await expect(sheet(page).locator(".sheet-name")).toHaveText("v1.4.0");
  await expect(sheet(page).locator(".step-text")).toHaveText(["Check it out (detached HEAD)", "Create a branch from it", "Push it to a remote", "Show only its history in the Log"]);
  await expect(sheet(page).locator(".step-text", { hasText: "Explain" })).toHaveCount(0);
});

test("a pill in the hover card opens the same sheet, its row selected", async ({ page }) => {
  await open(page);
  const row = page.locator("#rows .row").filter({ has: page.locator('.row-ref[data-ref="refs/heads/develop"][data-repo="/work/acme-web"]') }).first();
  const subject = await row.locator(".subject").first().boundingBox();
  await page.mouse.move(subject.x + 20, subject.y + subject.height / 2);
  await expect(page.locator("#hover-card")).toBeVisible({ timeout: 3000 });
  await page.locator('#hover-card [data-ref="refs/heads/develop"]').first().click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator(".sheet-name")).toHaveText("develop");
  await expect(row).toHaveAttribute("aria-selected", "true");
});

test("Reveal in Repo List puts the cursor on the branch's row there", async ({ page }) => {
  await open(page);
  await pill(page, "refs/heads/develop").click();
  await sheet(page).locator('button[data-action="reveal"]').click();
  await expect(page.locator("#repo-rows .repo-row.active")).toContainText("develop");
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`the sheet's chips, buttons and hints in ${theme}`, async ({ page }) => {
    const errors = await open(page, { theme });
    await pill(page, "refs/heads/develop").click();
    const color = (l) => l.evaluate((el) => getComputedStyle(el).color);
    const hint = await color(sheet(page).locator(".card-hint").first());
    const status = await color(sheet(page).locator(".card-status").first());
    // High contrast draws secondary text at full contrast: muted only in the other themes.
    if (!theme.startsWith("hc")) expect(hint, "the hint is muted").not.toBe(status);
    expect(await color(card(page, "Upstream").locator(".chip"))).not.toBe(hint);
    expect(await color(card(page, "Merges into").locator(".chip"))).not.toBe(hint);
    const primary = sheet(page).locator(".sheet-button.primary");
    const secondary = sheet(page).locator(".sheet-button:not(.primary)").first();
    // High contrast tells buttons apart by their border (VS Code's own do the same); the others by their fill.
    if (theme.startsWith("hc")) {
      for (const b of [primary, secondary]) expect(await b.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
    } else expect(await primary.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(await secondary.evaluate((el) => getComputedStyle(el).backgroundColor));
    expect(errors).toEqual([]);
  });
}

test("a narrow Changes view: buttons wrap, nothing spills out of the sheet", async ({ page }) => {
  await open(page, { layout: { changesPaneWidth: 280 } });
  await pill(page, "refs/heads/develop").click();
  await expect(sheet(page)).toBeVisible();
  const spill = await sheet(page).evaluate((el) => [...el.querySelectorAll("*")].filter((c) => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).map((c) => c.className));
  expect(spill).toEqual([]);
});

test("Across repositories: a repository not read says so, never 'Not in'; from the keyboard the focus lands on what was read", async ({ page }) => {
  const errors = await open(page, { across: "fail" });
  await pill(page, "refs/heads/develop").click();
  const across = card(page, "Across repositories");
  const read = across.locator(".sheet-button", { hasText: "Show in All Repositories" });
  await read.focus();
  await page.keyboard.press("Enter");
  // While reading it says so and keeps the focus.
  await expect(across.locator('.sheet-button[aria-disabled="true"]')).toHaveText("Reading the ticked repositories…");
  await expect(across.locator(".card-status")).toHaveText("develop is in 2 of 3 repositories: 1 checked out · 1 with commits to push · 1 with commits to pull. 1 repository could not be read.");
  await expect(across.locator(".card-hint")).toHaveText(["Could not read acme-libs."]);
  await expect(across.locator(".card-status")).toBeFocused();
  expect((await sent(page)).filter((m) => m.action === "across")).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("Across repositories: more than four without the branch open onto their names; read again, the sheet keeps what it showed", async ({ page }) => {
  const errors = await open(page, { across: "many" });
  // The sheet's data as the host sends it, to send it again (a branch moved: the sheet is read again).
  await page.evaluate(() => { window.sheetData = []; addEventListener("message", (e) => { if (e.data?.type === "branchSheet" && (e.data.data || e.data.across)) window.sheetData.push(e.data); }); });
  await pill(page, "refs/heads/develop").click();
  const across = card(page, "Across repositories");
  await across.locator(".sheet-button", { hasText: "Show in All Repositories" }).click();
  const more = across.locator("details.across-more");
  await expect(more.locator("summary")).toHaveText("Not in 6 other repositories.");
  await expect(more.locator("p")).toBeHidden();
  await more.locator("summary").click();
  await expect(more.locator("p")).toHaveText("acme-libs, acme-docs, acme-jobs, acme-mobile, acme-infra, acme-tools");
  await page.evaluate(() => window.postMessage(window.sheetData.findLast((m) => m.data), "*"));
  await expect(across.locator(".across-row .across-name")).toHaveText(["acme-web", "acme-api"]);
  await expect(across.locator(".sheet-button", { hasText: "Show in All Repositories" })).toHaveCount(0);
  // Its new read arrives while a row has the focus: that row keeps it.
  await across.locator(".across-row", { hasText: "acme-api" }).focus();
  await page.evaluate(() => window.postMessage(window.sheetData.findLast((m) => m.across), "*"));
  await expect(across.locator(".across-row", { hasText: "acme-api" })).toBeFocused();
  expect(errors).toEqual([]);
});

test("Across repositories: read only when asked; each repository's state, the rest in one line, its actions; a row opens that repository's sheet", async ({ page }) => {
  const errors = await open(page);
  await pill(page, "refs/heads/develop").click();
  const across = card(page, "Across repositories");
  await expect(across.locator(".card-status")).toHaveText("Where develop is in the other ticked repositories, and how it stands there.");
  expect((await sent(page)).filter((m) => m.action === "across"), "never read on its own").toHaveLength(0);
  await across.locator(".sheet-button", { hasText: "Show in All Repositories" }).click();
  await expect(across.locator(".card-status")).toHaveText("develop is in 2 of 3 repositories: 1 checked out · 1 with commits to push · 1 with commits to pull.");
  await expect(across.locator(".across-row .across-name")).toHaveText(["acme-web", "acme-api"]);
  await expect(across.locator(".across-row .across-state")).toHaveText(["↑2", "↓3"]);
  await expect(across.locator(".across-row.here")).toContainText("acme-web");
  await expect(across.locator(".card-hint")).toHaveText("Not in acme-libs.");
  expect(await buttons(across.locator(".card-buttons"))).toEqual(["Check Out Everywhere…", "Push…", "Update Project…"]);
  await across.locator(".sheet-button", { hasText: "Check Out Everywhere…" }).click();
  await expect.poll(async () => (await sent(page)).map((m) => m.action)).toContain("acrossCheckout");
  // A row: that repository's sheet of the same branch.
  await across.locator(".across-row", { hasText: "acme-api" }).click();
  await expect(sheet(page).locator(".sheet-repo")).toHaveText("acme-api");
  expect((await sent(page)).filter((m) => m.action === "open").at(-1)).toMatchObject({ repoId: "/work/acme-api", ref: "refs/heads/develop" });
  expect(errors).toEqual([]);
});
