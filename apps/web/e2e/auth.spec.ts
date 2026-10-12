import { expect, test } from "@playwright/test";

// Runs against the app WITHOUT the fixture and with Supabase unreachable. Signed-out visitors are guests only
// when the database confirms guest mode (rag.app_settings); when it can't, every page falls back to sign-in.

test("signed-out visitors are sent to the login page when guest mode can't be confirmed", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/search?q=hello");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("every app route is protected", async ({ page }) => {
  for (const path of ["/explorer", "/benchmarks", "/method"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/login/);
  }
});

test("the data APIs return nothing without database approval", async ({ request }) => {
  const retrieve = await request.post("/api/retrieve", { data: { query: "tariffs", embeddingSetId: "00000000-0000-0000-0000-000000000000" } });
  expect(retrieve.status()).toBeGreaterThanOrEqual(400);
  const layout = await request.get("/api/layout?doc=00000000-0000-0000-0000-000000000000&chunker=chunker/x@1");
  expect(layout.status()).toBeGreaterThanOrEqual(400);
});

test("the login form validates before contacting Supabase", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Enter your email" })).toBeVisible();
});

test("responses carry security headers", async ({ request }) => {
  const res = await request.get("/login");
  expect(res.headers()["x-frame-options"]).toBe("DENY");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});
