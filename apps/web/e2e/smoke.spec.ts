import { expect, test, type Page } from "@playwright/test";
import incidents from "./fixtures/snapshot/api/v1/incidents.json" with { type: "json" };

const first = incidents.items[0]!;

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("./");
  // first visit shows the introduction
  await page.getByRole("button", { name: "Explore on my own" }).click();
  return errors;
}

test("loads the public snapshot and lists real incidents", async ({ page }, info) => {
  const errors = await open(page);
  // phones show only the status dot; its title carries the same information
  await expect(page.locator('[title^="Public static snapshot"]')).toBeVisible();
  if (info.project.name === "phone") await page.getByRole("tab", { name: /Incidents/ }).click();
  await expect(page.getByText(first.title).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("opens an incident with its intelligence tabs", async ({ page }, info) => {
  const errors = await open(page);
  if (info.project.name === "phone") await page.getByRole("tab", { name: /Incidents/ }).click();
  await page.getByText(first.title).first().click();
  await expect(page.getByRole("heading", { level: 1, name: first.title })).toBeVisible();
  for (const tab of ["Intelligence", "Exposure", "Satellite", "Links"]) {
    await expect(page.getByRole("tab", { name: new RegExp(`^${tab}`) })).toBeVisible();
  }
  await page.getByRole("tab", { name: /^Links/ }).click();
  await expect(page.getByText(/Knowledge graph/i)).toBeVisible();
  if (info.project.name === "phone") await expect(page.getByRole("button", { name: /All incidents|Overview/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the command palette finds an incident", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "keyboard shortcut");
  await open(page);
  await page.keyboard.press("Control+k");
  const input = page.getByRole("dialog", { name: "Command palette" }).locator("input");
  const word = first.title.split(/\s+/).find((w) => w.length > 4) ?? first.title;
  await input.fill(word);
  await expect(page.getByRole("dialog", { name: "Command palette" }).getByText(first.title).first()).toBeVisible();
});

test("local-only features say so instead of failing", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "desktop top bar");
  await open(page);
  await page.getByRole("button", { name: /^Ask$/ }).click();
  await expect(page.getByText(/isn't available on this public snapshot/)).toBeVisible();
});

test("the simulation is labelled as a simulation", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "desktop flow");
  await open(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog", { name: "Command palette" }).locator("input").fill("simulation lab");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Click anywhere on the globe/)).toBeVisible();
});
