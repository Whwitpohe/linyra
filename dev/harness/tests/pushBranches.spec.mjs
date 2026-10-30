// Branches with commits to push that are not checked out (develop merged into master locally):
// the Repo List shows each branch's ↑ and ↓ (repoPane.ts), and Push…'s checklist lists them under a
// heading of their own (multiRepo.ts), which the in-panel checklist draws as a heading (ui/prompt.ts).
import { expect, test } from "@playwright/test";

const open = async (page) => {
  await page.setViewportSize({ width: 1300, height: 640 });
  await page.goto("/?theme=dark&state=default&avatars=off");
  await expect(page.locator("#repo-rows .repo-row").first()).toBeVisible();
};
const branch = (page, name) => page.locator("#repo-rows .branch-row").filter({ has: page.locator(".branch-name", { hasText: new RegExp(`^${name}$`) }) }).first();

test("the Repo List shows every local branch's commits to push and to pull, not only the checked-out one's", async ({ page }) => {
  await open(page);
  await page.locator("#repo-rows .repo-row").filter({ hasText: "acme-web" }).first().locator(".tree-twisty").click();
  await expect(branch(page, "master")).toBeVisible();
  await expect(branch(page, "master").locator(".branch-sync .sync-out")).toHaveText("↑3");
  await expect(branch(page, "master").locator(".branch-sync .sync-in")).toHaveCount(0);
  await expect(branch(page, "master")).toHaveAttribute("title", /Tracks origin\/master[\s\S]*3/);
  await expect(branch(page, "develop").locator(".branch-sync")).toHaveText("↓2↑1");
  // Remote branches have no upstream of their own: nothing shown.
  await expect(page.locator("#repo-rows .branch-row .branch-sync")).toHaveCount(2);
});

test("Push…'s checklist: a heading for the branches not checked out, never ticked or chosen, skipped by the keys", async ({ page }) => {
  await open(page);
  const request = { kind: "pickMany", title: "Push to 2 repositories", items: [
    { label: "acme-web", description: "develop → origin/develop · 1 commit", picked: true },
    { label: "Other branches with commits to push", separator: true },
    { label: "acme-web", description: "master → origin/master · 3 commits", picked: true },
    { label: "acme-api", description: "master → origin/master · 2 commits", picked: true },
    { label: "Needs pull or force push", separator: true },
    { label: "acme-libs", description: "develop → origin/develop · 1 commit", detail: "Tick to force push", picked: false },
  ] };
  await page.evaluate((r) => window.harnessAsk(r, "toolbar-push"), request);
  const prompt = page.locator(".prompt");
  await expect(prompt.locator(".prompt-heading")).toHaveText(["Other branches with commits to push", "Needs pull or force push"]);
  await expect(prompt.locator(".prompt-heading[role='option']")).toHaveCount(0);
  await expect(prompt.locator(".prompt-item")).toHaveCount(4);
  expect(await prompt.locator(".prompt-item").evaluateAll((els) => els.map((e) => e.getAttribute("aria-selected")))).toEqual(["true", "true", "true", "false"]);
  // ↓ from the first choice lands on the next choice, past the heading.
  await expect(prompt.locator(".prompt-item").first()).toHaveClass(/active/);
  await page.keyboard.press("ArrowDown");
  await expect(prompt.locator(".prompt-item").nth(1)).toHaveClass(/active/);
  await prompt.locator(".prompt-ok").click();
  const sent = await page.evaluate(() => window.harnessMessages.filter((m) => m.type === "promptAnswer"));
  expect(sent.at(-1).answer).toEqual({ indexes: [0, 2, 3] }, "the ticked choices, by their place among the items: headings never");
});

test("filtering a long checklist keeps a heading only above its own matches", async ({ page }) => {
  await open(page);
  const names = ["web", "api", "libs", "docs", "jobs", "mobile", "infra", "tools"];
  const items = [...names.slice(0, 4).map((n) => ({ label: `acme-${n}`, description: "develop → origin/develop", picked: true })),
    { label: "Other branches with commits to push", separator: true },
    ...names.slice(4).map((n) => ({ label: `acme-${n}`, description: "master → origin/master", picked: true }))];
  await page.evaluate((r) => window.harnessAsk(r, "toolbar-push"), { kind: "pickMany", title: "Push to 8 repositories", items });
  await expect(page.locator(".prompt .prompt-filter")).toBeFocused();
  await page.keyboard.type("develop");
  await expect(page.locator(".prompt .prompt-item")).toHaveCount(4);
  await expect(page.locator(".prompt .prompt-heading")).toHaveCount(0);
  await page.locator(".prompt .prompt-filter").fill("mobile");
  await expect(page.locator(".prompt .prompt-heading")).toHaveText(["Other branches with commits to push"]);
  await expect(page.locator(".prompt .prompt-item")).toHaveText([/acme-mobile/]);
});
