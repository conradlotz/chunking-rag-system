import { expect, test, type Page } from "@playwright/test";

// Runs against the development fixture (pipeline/tests/fixtures/load_dev_fixture.py).

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return errors;
}

async function search(page: Page, q: string) {
  await page.fill("#q", q);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForSelector('[data-testid="hit"]');
}

test("overview shows the corpus and four separate resource panels", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What the system is holding" })).toBeVisible();
  await expect(page.locator('[data-testid="kpis"]')).toContainText("Filings");
  await expect(page.locator('[data-testid="layout-table"] tbody tr')).not.toHaveCount(0);
  for (const id of ["bandwidth", "embedding", "storage", "llm"]) await expect(page.getByTestId(`panel-${id}`)).toBeVisible();
  await expect(page.getByTestId("panel-llm")).toContainText("billed per token");
  await expect(page.getByTestId("panel-embedding")).toContainText("no per-token charge");
  expect(errors).toEqual([]);
});

test("search returns ranked, highlighted passages with fusion ranks and timings", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/search");
  await search(page, "How do tariffs affect gross margin?");
  const first = page.getByTestId("hit").first();
  await expect(first).toContainText(/tariff/i);
  await expect(first.locator("mark.term").first()).toBeVisible();
  await expect(first).toContainText(/vector \d+/);
  await expect(page.getByTestId("timings")).toContainText("total");
  expect(page.url()).toContain("q=How");
  expect(errors).toEqual([]);
});

test("filters restrict results to the chosen fiscal year", async ({ page }) => {
  await page.goto("/search");
  await page.getByRole("group", { name: "Fiscal years" }).getByRole("button", { name: "2025" }).click();
  await search(page, "gross margin freight costs");
  const cards = page.getByTestId("hit");
  const n = await cards.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) await expect(cards.nth(i)).toContainText("FY2025");
});

test("keyword mode finds passages by their words", async ({ page }) => {
  await page.goto("/search");
  await page.getByRole("group", { name: "Retrieval mode" }).getByRole("button", { name: "Keyword" }).click();
  await search(page, "cybersecurity incident ransomware");
  await expect(page.getByTestId("hit").first()).toContainText(/cyber/i);
});

test("context expansion adds neighbouring blocks and never exceeds the budget", async ({ page }) => {
  await page.goto("/search");
  await page.getByRole("group", { name: "Token budget" }).getByRole("button", { name: "2K" }).click();
  await search(page, "How do tariffs affect gross margin?");
  await page.getByRole("tab", { name: /Context/ }).click();
  const used = async () => {
    const label = await page.getByTestId("budget-bar").getByRole("img").getAttribute("aria-label");
    const m = label?.match(/uses (\d+) of (\d+) tokens/);
    return { used: Number(m?.[1]), budget: Number(m?.[2]) };
  };
  const staticUse = await used();
  const staticSpans = await page.locator('[data-testid="context-run"]').count();
  expect(staticUse.used).toBeLessThanOrEqual(staticUse.budget);

  await page.getByRole("tab", { name: /Ranked units/ }).click();
  await page.getByRole("button", { name: "Expand" }).click();
  await page.getByRole("group", { name: "Neighbour expansion" }).getByRole("button", { name: "1" }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForSelector('[data-testid="hit"]');
  await page.getByRole("tab", { name: /Context/ }).click();
  const expanded = await used();
  expect(expanded.used).toBeLessThanOrEqual(expanded.budget);
  expect(expanded.used).toBeGreaterThanOrEqual(staticUse.used);
  await expect(page.getByTestId("budget-bar")).toContainText("Neighbouring block");
  expect(await page.locator('[data-testid="context-run"]').count()).toBeGreaterThanOrEqual(1);
  expect(staticSpans).toBeGreaterThanOrEqual(1);
});

test("an empty or one-letter question is refused", async ({ page }) => {
  await page.goto("/search");
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
  const res = await page.request.post("/api/retrieve", { data: { query: "a", embeddingSetId: "x" } });
  expect(res.status()).toBe(400);
});

test("explorer draws chunk boundaries, compares two layouts and reports answer-span containment", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/explorer");
  await page.locator('[data-testid="filings"] a').first().click();
  await expect(page.getByRole("link", { name: /View original at sec\.gov/ })).toHaveAttribute("href", /^https:\/\/www\.sec\.gov\//);
  await page.getByRole("tab", { name: /Item 1A/ }).click();
  await page.waitForSelector(".cb");
  const before = await page.locator('.cb[data-side="B"]').count();
  expect(before).toBe(0);
  await page.selectOption("#lb", { index: 2 });
  await page.waitForSelector('.cb[data-side="B"]');
  await expect(page.getByTestId("layout-compare")).toContainText("Chunks");
  await expect(page.getByTestId("gold-panel")).toContainText("Containment");
  expect(errors).toEqual([]);
});

test("explorer highlights a passage opened from a search hit", async ({ page }) => {
  await page.goto("/search");
  await search(page, "How do tariffs affect gross margin?");
  await page.getByTestId("hit").first().getByRole("link", { name: /Open in Explorer/ }).click();
  await expect(page.locator(".hlspan").first()).toBeVisible();
});

test("benchmarks show the size curve, the cost frontier and the table", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/benchmarks");
  await expect(page.getByRole("heading", { name: "Does changing the chunk size help?" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("Development fixture");
  await expect(page.getByTestId("param-curve")).toBeVisible();
  await expect(page.getByTestId("pareto")).toBeVisible();
  await expect(page.getByTestId("sweep-table").getByText("Pareto").first()).toBeVisible();
  await page.selectOption("#qm", "mrr");
  await expect(page.getByTestId("param-curve")).toBeVisible();
  await page.selectOption("#cm", "tokens_embedded");
  await expect(page.getByTestId("pareto")).toBeVisible();
  expect(errors).toEqual([]);
});

test("method page explains the four costs", async ({ page }) => {
  await page.goto("/method");
  for (const t of ["Bandwidth", "Local embedding compute", "Storage", "Paid generation"]) await expect(page.getByRole("heading", { name: t })).toBeVisible();
});

test("theme toggle switches and persists", async ({ page }) => {
  await page.goto("/method");
  await page.getByRole("button", { name: /Switch to dark theme|Switch to light theme/ }).first().click();
  const t = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  expect(["light", "dark"]).toContain(t);
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(t);
});

test("phone width has no horizontal page scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  for (const path of ["/", "/search", "/explorer", "/benchmarks", "/method"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
});
