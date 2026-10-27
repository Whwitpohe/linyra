// Builds the README/marketplace demo workspace: six neutral "acme-*" repositories whose
// histories tell one story (ticket ACME-142, saved cards, landed across four repos in
// the last few hours) on top of ~3 months of ordinary history. Dev-only.
//
//   node dev/demo/seed.mjs [temporary-demo-directory]
//   code <temporary-demo-directory>/acme.code-workspace
//
// Build it at a path with no username in it: tooltips and titles show absolute paths,
// and a fixture under ~/ puts /home/<you>/ into every screenshot. Dates are relative to
// now, so the default "last 24 hours" range is full — re-seed before every take.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? join(tmpdir(), "linyra-demo"));
const insideTemp = relative(resolve(tmpdir()), dir);
if (!insideTemp || insideTemp.startsWith("..") || isAbsolute(insideTemp)
  || !/^(?:linyra|polylog)-demo(?:[-/\\]|$)/.test(insideTemp)) {
  throw new Error("seed only inside a named Linyra demo directory under the system temporary folder");
}
const marker = join(dir, ".linyra-demo");
if (existsSync(dir) && !existsSync(marker)) throw new Error("refusing to replace a directory not created by this demo seeder");
rmSync(dir, { recursive: true, force: true });
const home = join(dir, ".home");
mkdirSync(home, { recursive: true });
writeFileSync(marker, "Linyra neutral documentation fixture\n");
// "Me" is dana: the author filter's Me button reads this.
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = dana\n\temail = dana@example.com\n");
const baseEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig") };

const now = Math.floor(Date.now() / 1000);
const H = 3600;
const D = 86_400;
const AUTHORS = ["dana", "rin", "sam", "noor"];

// ---- The story: what the demo actually shows (hours ago, newest first on screen) ----

const savedCardsWeb = `import { useEffect, useState } from "react";
import { CardBrandIcon, formatMoney } from "@acme/libs";
import { api, type SavedCard } from "../api/client";

export function SavedCards({ onPick }: { onPick: (card: SavedCard) => void }) {
  const [cards, setCards] = useState<SavedCard[]>([]);

  useEffect(() => {
    void api.savedCards().then(setCards);
  }, []);

  if (cards.length === 0) return null;
  return (
    <ul className="saved-cards">
      {cards.map((card) => (
        <li key={card.id}>
          <button onClick={() => onPick(card)}>
            <CardBrandIcon brand={card.brand} />
            •••• {card.last4} <span>expires {card.expiry}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
`;

const paymentStep = (withSaved) => `import { useState } from "react";
import { CardForm } from "./CardForm";
${withSaved ? 'import { SavedCards } from "./SavedCards";\nimport type { SavedCard } from "../api/client";\n' : ""}import { OrderSummary } from "./OrderSummary";

export function PaymentStep({ total, onPay }: PaymentStepProps) {
  const [submitting, setSubmitting] = useState(false);
${withSaved ? "  const [picked, setPicked] = useState<SavedCard | null>(null);\n" : ""}
  async function pay(token: string) {
    setSubmitting(true);
    try {
      await onPay(token);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="payment-step">
      <OrderSummary total={total} />
${withSaved ? `      <SavedCards onPick={setPicked} />
      {picked ? (
        <button disabled={submitting} onClick={() => pay(picked.token)}>
          Pay with •••• {picked.last4}
        </button>
      ) : (
        <CardForm disabled={submitting} onToken={pay} />
      )}
` : "      <CardForm disabled={submitting} onToken={pay} />\n"}    </section>
  );
}

interface PaymentStepProps {
  total: number;
  onPay: (token: string) => Promise<void>;
}
`;

const clientTs = (withSaved) => `const BASE = "/api/v2";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { credentials: "include" });
  if (!res.ok) throw new Error(\`\${res.status} \${path}\`);
  return (await res.json()) as T;
}

export const api = {
  cart: () => get<Cart>("/cart"),
  orders: () => get<Order[]>("/orders"),
${withSaved ? '  savedCards: () => get<SavedCard[]>("/payments/cards"),\n' : ""}};

export interface Cart { items: { sku: string; qty: number }[]; total: number }
export interface Order { id: string; placedAt: string; total: number }
${withSaved ? 'export interface SavedCard { id: string; token: string; brand: "visa" | "mastercard" | "amex"; last4: string; expiry: string }\n' : ""}`;

const cardsService = `import { db } from "../db";

export interface SavedCard {
  id: string;
  token: string;
  brand: "visa" | "mastercard" | "amex";
  last4: string;
  expiry: string;
}

/** A customer's saved cards, most recently used first. Never returns the full PAN. */
export async function listSavedCards(customerId: string): Promise<SavedCard[]> {
  const rows = await db.query(
    "select id, token, brand, last4, exp_month, exp_year from saved_cards where customer_id = $1 order by last_used_at desc",
    [customerId],
  );
  return rows.map((r) => ({
    id: r.id,
    token: r.token,
    brand: r.brand,
    last4: r.last4,
    expiry: \`\${String(r.exp_month).padStart(2, "0")}/\${String(r.exp_year).slice(-2)}\`,
  }));
}
`;

const paymentsRoutes = (withCards) => `import { Router } from "express";
import { requireCustomer } from "../auth";
import { charge } from "../services/charge";
${withCards ? 'import { listSavedCards } from "../services/cards";\n' : ""}
export const payments = Router();

payments.post("/payments/charge", requireCustomer, async (req, res) => {
  const receipt = await charge(req.customer.id, req.body.token, req.body.amount);
  res.status(201).json(receipt);
});
${withCards ? `
payments.get("/payments/cards", requireCustomer, async (req, res) => {
  res.json(await listSavedCards(req.customer.id));
});
` : ""}`;

const cardBrandIcon = `const LABELS = { visa: "Visa", mastercard: "Mastercard", amex: "American Express" } as const;

export type CardBrand = keyof typeof LABELS;

/** A small brand mark for a saved card. Decorative: the label carries the meaning. */
export function CardBrandIcon({ brand }: { brand: CardBrand }) {
  return <span className={\`card-brand card-brand--\${brand}\`} aria-label={LABELS[brand]} />;
}
`;

const libsIndex = (withIcon) => `export { formatMoney } from "./format/money";
export { Button } from "./ui/Button";
${withIcon ? 'export { CardBrandIcon, type CardBrand } from "./ui/CardBrandIcon";\n' : ""}`;

const money = (jpyFix) => `const DIGITS: Record<string, number> = { USD: 2, EUR: 2, GBP: 2${jpyFix ? ", JPY: 0" : ""} };

export function formatMoney(amount: number, currency = "USD"): string {
  const digits = DIGITS[currency] ?? 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
}
`;

// Each story commit: [repo, hoursAgo, author, message, files]
const STORY = [
  ["acme-web", 0.4, "rin", "feat(checkout): pay with a saved card (ACME-142)", {
    "src/checkout/SavedCards.tsx": savedCardsWeb,
    "src/checkout/PaymentStep.tsx": paymentStep(true),
    "src/api/client.ts": clientTs(true),
  }],
  ["acme-docs", 1.1, "noor", "docs(payments): saved cards guide (ACME-142)", {
    "guides/payments/saved-cards.md": "# Saved cards\n\nCustomers who opt in can pay with a card they used before.\n\n- The API returns the brand, last four digits and expiry — never the full number.\n- Cards are listed most recently used first.\n- Removing a card takes effect immediately.\n",
    "guides/payments/index.md": "# Payments\n\n- [Charging a card](charge.md)\n- [Refunds](refunds.md)\n- [Saved cards](saved-cards.md)\n",
  }],
  ["acme-api", 1.7, "dana", "feat(payments): list a customer's saved cards (ACME-142)", {
    "src/services/cards.ts": cardsService,
    "src/routes/payments.ts": paymentsRoutes(true),
    "test/cards.test.ts": 'import { listSavedCards } from "../src/services/cards";\n\ntest("never exposes the full card number", async () => {\n  const [card] = await listSavedCards("cus_1");\n  expect(card).not.toHaveProperty("pan");\n  expect(card.last4).toHaveLength(4);\n});\n',
  }],
  ["acme-libs", 2.3, "rin", "feat(ui): CardBrandIcon for Visa, Mastercard and Amex (ACME-142)", {
    "src/ui/CardBrandIcon.tsx": cardBrandIcon,
    "src/index.ts": libsIndex(true),
  }],
  ["acme-web", 3.4, "dana", "fix(nav): keep the cart badge in sync after sign-out", { "src/nav/CartBadge.tsx": "import { useCart } from \"../cart/useCart\";\n\nexport function CartBadge() {\n  const { count, signedIn } = useCart();\n  if (!signedIn || count === 0) return null;\n  return <span className=\"badge\">{count}</span>;\n}\n" }],
  ["acme-mobile", 4.2, "sam", "fix(ios): don't crash when camera permission is denied", { "ios/Scanner/ScannerView.swift": "import AVFoundation\nimport SwiftUI\n\nstruct ScannerView: View {\n    @State private var denied = false\n\n    var body: some View {\n        if denied {\n            Text(\"Allow camera access in Settings to scan cards.\")\n        } else {\n            CameraPreview(onDenied: { denied = true })\n        }\n    }\n}\n" }],
  ["acme-api", 5.1, "noor", "fix(orders): return 404 for unknown order ids", { "src/routes/orders.ts": "import { Router } from \"express\";\nimport { findOrder } from \"../services/orders\";\n\nexport const orders = Router();\n\norders.get(\"/orders/:id\", async (req, res) => {\n  const order = await findOrder(req.params.id);\n  if (!order) return res.status(404).json({ error: \"order not found\" });\n  res.json(order);\n});\n" }],
  ["acme-infra", 6.3, "noor", "ci: cache node_modules between jobs", { ".github/workflows/ci.yml": "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n          cache: npm\n      - run: npm ci\n      - run: npm test\n" }],
  ["acme-web", 7.2, "sam", "chore: bump vite to 5.4", { "package.json": "{\n  \"name\": \"acme-web\",\n  \"private\": true,\n  \"scripts\": { \"dev\": \"vite\", \"build\": \"vite build\" },\n  \"dependencies\": { \"@acme/libs\": \"^2.3.0\", \"react\": \"^18.3.1\" },\n  \"devDependencies\": { \"vite\": \"^5.4.0\" }\n}\n" }],
  ["acme-libs", 9.0, "rin", "fix(format): no decimals for JPY", { "src/format/money.ts": money(true) }],
  ["acme-api", 11.4, "dana", "perf(search): cache facet counts per request", { "src/services/search.ts": "const facetCache = new WeakMap<object, Map<string, number>>();\n\nexport function facetCounts(req: object, field: string, count: () => number): number {\n  let byField = facetCache.get(req);\n  if (!byField) facetCache.set(req, (byField = new Map()));\n  if (!byField.has(field)) byField.set(field, count());\n  return byField.get(field)!;\n}\n" }],
  ["acme-docs", 13.0, "noor", "docs: fix broken links in the API reference", { "reference/index.md": "# API reference\n\n- [Orders](orders.md)\n- [Payments](payments.md)\n- [Search](search.md)\n" }],
  ["acme-web", 15.5, "rin", "refactor(checkout): split PaymentStep into smaller parts", {
    "src/checkout/PaymentStep.tsx": paymentStep(false),
    "src/checkout/OrderSummary.tsx": "import { formatMoney } from \"@acme/libs\";\n\nexport function OrderSummary({ total }: { total: number }) {\n  return <p className=\"order-summary\">Total <strong>{formatMoney(total)}</strong></p>;\n}\n",
  }],
  ["acme-mobile", 17.3, "dana", "feat(android): pull to refresh on orders", { "android/app/src/main/java/com/acme/orders/OrdersScreen.kt": "package com.acme.orders\n\n@Composable\nfun OrdersScreen(vm: OrdersViewModel) {\n    val state by vm.state.collectAsState()\n    PullToRefreshBox(isRefreshing = state.loading, onRefresh = vm::refresh) {\n        OrdersList(state.orders)\n    }\n}\n" }],
  ["acme-libs", 19.2, "sam", "docs: usage examples for formatMoney", { "README.md": "# @acme/libs\n\n```ts\nformatMoney(12.5)        // \"$12.50\"\nformatMoney(1200, \"JPY\") // \"¥1,200\"\n```\n" }],
  ["acme-infra", 21.0, "sam", "chore(k8s): raise api memory limit to 512Mi", { "k8s/api/deployment.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: acme-api\nspec:\n  replicas: 3\n  template:\n    spec:\n      containers:\n        - name: api\n          image: acme/api:1.4\n          resources:\n            limits:\n              memory: 512Mi\n" }],
];

// ---- Background: ~3 months of ordinary history, so File History and "All time" have depth ----

const AREAS = {
  "acme-web": ["checkout", "cart", "nav", "search", "account"],
  "acme-api": ["orders", "payments", "search", "auth", "catalog"],
  "acme-libs": ["ui", "format", "hooks", "http"],
  "acme-docs": ["guides", "reference", "changelog"],
  "acme-mobile": ["orders", "scanner", "profile", "push"],
  "acme-infra": ["k8s", "ci", "terraform", "monitoring"],
};
const SUBJECTS = [
  "feat: add an empty state", "fix: retry once on timeout", "feat: paginate results",
  "fix: clearer error messages", "feat: show a loading skeleton", "fix: validate input before submit",
  "refactor: extract shared config", "perf: memoize the expensive lookup", "test: cover the error path",
  "fix: keep focus after closing the dialog", "chore: remove dead code", "fix: handle an empty response",
  "feat: sort by most recent", "chore: tighten types", "fix: off-by-one in the page count",
];

function background(repo, seed) {
  const out = [];
  const areas = AREAS[repo];
  const count = 26 + (seed * 7) % 14;
  for (let i = 0; i < count; i++) {
    const n = seed * 31 + i * 17;
    const area = areas[n % areas.length];
    const [type, rest] = SUBJECTS[(n >> 1) % SUBJECTS.length].split(": ");
    const t = now - 26 * H - Math.floor(((count - i) / count) * 88 * D) - (n % 50) * 60;
    const ticket = i % 3 === 0 ? ` (ACME-${100 + ((n * 7) % 40)})` : "";
    const file = repo === "acme-web" && area === "checkout" ? "src/checkout/PaymentStep.tsx" : `src/${area}/config.ts`;
    out.push({ t, author: AUTHORS[n % AUTHORS.length], message: `${type}(${area}): ${rest}${ticket}`, file, i });
  }
  return out;
}

function configBody(area, i) {
  return `// ${area} settings\nexport const ${area}Config = {\n  retries: ${1 + (i % 4)},\n  timeoutMs: ${1000 + (i % 5) * 500},\n  pageSize: ${20 + (i % 3) * 10},\n};\n`;
}

// ---- Build ----

function commit(repo, t, author, message, files) {
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), content);
  }
  const email = `${author}@example.com`;
  const date = `@${t} +0000`;
  const env = { ...baseEnv, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: date };
  execFileSync("git", ["add", "-A"], { cwd: repo, env });
  const body = message.includes("ACME-142")
    ? `${message}\n\nConnect saved-card checkout across the web, API, shared UI and documentation.\nKeep existing payment flows available while the new branch is reviewed.\n\nCo-Authored-By: Rin <rin@example.com>` : message;
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", body], { cwd: repo, env });
}

const repos = Object.keys(AREAS);
let total = 0;
repos.forEach((name, seed) => {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: baseEnv });
  // Initial files the story edits, so its diffs are real modifications.
  const initial = {
    "acme-web": { "src/checkout/PaymentStep.tsx": paymentStep(false), "src/api/client.ts": clientTs(false) },
    "acme-api": { "src/routes/payments.ts": paymentsRoutes(false) },
    "acme-libs": { "src/index.ts": libsIndex(false), "src/format/money.ts": money(false) },
    "acme-docs": { "guides/payments/index.md": "# Payments\n\n- [Charging a card](charge.md)\n- [Refunds](refunds.md)\n" },
    "acme-mobile": {},
    "acme-infra": {},
  }[name];
  commit(repo, now - 92 * D + seed * 600, AUTHORS[seed % 4], `chore: initial ${name}`, { "README.md": `# ${name}\n`, ...initial });
  total++;
  for (const b of background(name, seed)) {
    // Background edits to PaymentStep only touch a comment line, so the story's diff stays clean.
    const files = b.file.endsWith("PaymentStep.tsx")
      ? { [b.file]: paymentStep(false).replace("export function", `// checkout rev ${b.i}\nexport function`) }
      : { [b.file]: configBody(b.file.split("/")[1], b.i) };
    commit(repo, b.t, b.author, b.message, files);
    total++;
  }
  // The release line was cut yesterday: it predates everything in the story.
  if (["acme-web", "acme-api", "acme-libs"].includes(name)) {
    execFileSync("git", ["update-ref", "refs/remotes/origin/release-1.4", "HEAD"], { cwd: repo, env: baseEnv });
  }
  for (const [r, hours, author, message, files] of [...STORY].reverse()) {
    if (r !== name) continue;
    commit(repo, now - Math.round(hours * H), author, message, files);
    total++;
  }
  if (["acme-web", "acme-api", "acme-libs"].includes(name)) {
    const git = (...args) => execFileSync("git", args, { cwd: repo, env: baseEnv, encoding: "utf8" }).trim();
    git("branch", "release-1.4", "refs/remotes/origin/release-1.4");
    git("checkout", "-q", "-b", "feature/saved-cards", "HEAD~2");
    commit(repo, now - 3000 + seed * 80, "rin", "feat: preview saved-card rollout (ACME-142)", {
      "src/payments/rollout.ts": "export const savedCardRollout = { enabled: true, preview: true };\n",
    });
    git("update-ref", "refs/remotes/origin/feature/saved-cards", "HEAD");
    git("checkout", "-q", "main");
    const date = `@${now - 900 + seed * 60} +0000`;
    execFileSync("git", ["merge", "-q", "--no-ff", "feature/saved-cards", "-m",
      "Merge saved-card preview into main (ACME-142)\n\nKeep the incoming branch visible in the history graph.\nReview all repositories together before the rollout.\n\nCo-Authored-By: Rin <rin@example.com>"], {
      cwd: repo, env: { ...baseEnv, GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com",
        GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("tag", "v1.4.1-demo");
    git("checkout", "-q", "release-1.4");
    commit(repo, now - 1350 + seed * 60, "dana", "fix(payments): cap checkout retries (ACME-153)", {
      "src/payments/retry.ts": "export const paymentRetryLimit = 3;\n",
    });
    git("update-ref", "refs/remotes/origin/release-1.4", "HEAD");
    git("checkout", "-q", "main");
    total += 3;
  }
});

// Review-only examples: the recording never stages, discards or commits these files.
writeFileSync(join(dir, "acme-web", "src/checkout/PaymentStep.tsx"), paymentStep(true).replace("useState(false)", "useState(true)"));
writeFileSync(join(dir, "acme-api", "review-notes.md"), "# Review notes\n\nVerify the saved-card rollout across repositories.\n");

writeFileSync(join(dir, "acme.code-workspace"), JSON.stringify({
  folders: repos.map((path) => ({ path })),
  settings: {
    "editor.minimap.enabled": false,
    "breadcrumbs.enabled": false,
    "editor.lightbulb.enabled": "off",
    "problems.decorations.enabled": false,
    "diffEditor.hideUnchangedRegions.enabled": true,
    "window.title": "Linyra Demo — ${activeEditorShort}",
  },
}, null, 2) + "\n");
console.log(`demo: ${repos.length} repos, ${total} commits in ${dir}\n  code ${join(dir, "acme.code-workspace")}`);
