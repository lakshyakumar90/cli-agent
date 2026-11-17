import { test, expect } from "@playwright/test";
import { docs } from "../lib/docs";
test("all guides render with correct headings and no browser exceptions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const doc of docs) {
    const response = await page.goto(doc.slug ? `/docs/${doc.slug}` : "/docs");
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText(doc.title);
    await expect(page.locator(".prose")).toBeVisible();
  }
  expect(errors).toEqual([]);
});
test("workflow and provider tabs, full-text search, and clipboard work", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("tab", { name: "Explore", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Build", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "Review" })).toContainText(
    "/review",
  );
  await page.getByRole("tab", { name: "OpenCode", exact: true }).click();
  await expect(page.locator("#provider-detail")).toContainText(
    "opencode-cli/provider/model",
  );
  await page
    .locator("#provider-detail")
    .getByRole("button", { name: "Copy", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "agent --model opencode-cli/provider/model",
  );
  await page.getByRole("button", { name: /Search documentation/ }).click();
  await page.getByRole("textbox", { name: "Search guides" }).fill("snapshot");
  await expect(
    page.getByRole("dialog").getByRole("link").first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
});
test("flowcharts render and source reference can find a file", async ({
  page,
}) => {
  for (const slug of [
    "decisions",
    "architecture",
    "agent-loop",
    "permissions",
    "sessions",
    "workers",
    "providers",
    "terminal-ui",
  ]) {
    await page.goto(`/docs/${slug}`);
    await page.locator(".diagram").scrollIntoViewIfNeeded();
    await expect(page.locator(".diagram-svg svg")).toBeVisible({
      timeout: 30000,
    });
    await expect(
      page.getByRole("link", { name: "Download .mmd source" }),
    ).toHaveAttribute("href", /\.mmd$/);
  }
  await page.goto("/docs/repository");
  await page
    .getByRole("textbox", { name: "Find a source file" })
    .fill("worker-manager.ts");
  await expect(page.locator(".file-list")).toContainText(
    "Own worker lifetimes",
  );
  await expect(page.locator(".file-count")).toContainText("1 of");
});
test("mobile navigation, diagrams and long content stay within viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const url of [
    "/",
    "/docs",
    "/docs/architecture",
    "/docs/repository",
    "/docs/decisions",
    "/docs/infrastructure",
    "/docs/performance",
  ]) {
    await page.goto(url);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto("/docs");
  await page
    .getByRole("button", { name: "Search documentation", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".mobile-doc-nav>summary").click();
  await page
    .locator(".mobile-doc-nav")
    .getByRole("link", { name: "Installation", exact: true })
    .click();
  await expect(page.locator("h1")).toHaveText("Installation");
});

test("compact demonstration keeps each workflow result and status inside its crop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  for (const name of ["Explore", "Build", "Review"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(page.locator(".agent-stage .ss-stage")).toHaveAttribute(
      "data-layout",
      "compact",
    );
    const stage = await page.locator(".agent-stage .ss-stage").boundingBox();
    const status = await page
      .locator(".agent-window .terminal-status")
      .boundingBox();
    expect(status!.y + status!.height).toBeLessThanOrEqual(
      stage!.y + stage!.height,
    );
    await expect(page.locator(".terminal-answer")).toBeVisible();
  }
});
