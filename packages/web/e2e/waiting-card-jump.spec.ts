import { expect, test } from "@playwright/test";
import { openWaitingCard, type WaitingCardKind } from "./waiting-card-fixture";

for (const viewport of [
  { name: "phone", width: 390, height: 844, hasTouch: true },
  { name: "desktop", width: 1280, height: 900, hasTouch: false },
  { name: "narrow", width: 320, height: 800, hasTouch: true },
]) {
  test.describe(viewport.name, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.hasTouch,
    });

    for (const kind of ["routine", "plan", "question"] satisfies WaitingCardKind[]) {
      test(`${kind}: an off-screen waiting card can be reached without losing jump to latest`, async ({
        page,
      }) => {
        await openWaitingCard(page, kind);
        const jump = page.getByRole("button", { name: "Jump to waiting card" });
        const card = page.locator("[data-chat-pending-card]");
        await expect(jump).toBeVisible();
        await expect(card).not.toBeInViewport();
        await page.evaluate(() => document.fonts.ready);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: test.info().outputPath(`${kind}-${viewport.name}-indicator.png`),
        });
        await jump.click();
        await expect(card).toBeInViewport();
        await expect(card).toBeFocused();
        await expect(jump).toHaveCount(0);
        await page.screenshot({
          path: test.info().outputPath(`${kind}-${viewport.name}-card.png`),
        });
        await page.getByRole("button", { name: "Jump to the latest message" }).click();
        await expect(jump).toBeVisible();
        await expect(card).not.toBeInViewport();
      });

      test(`${kind}: resolving the card removes the indicator even off-screen`, async ({
        page,
      }) => {
        await openWaitingCard(page, kind);
        const jump = page.getByRole("button", { name: "Jump to waiting card" });
        await jump.click();
        if (kind === "routine") {
          await page.getByRole("button", { name: "Turn it on", exact: true }).click();
          await expect(page.getByText("On", { exact: true })).toBeVisible();
        } else if (kind === "plan") {
          await page.getByRole("button", { name: "Approve", exact: true }).click();
          await expect(page.getByText("Approved", { exact: true })).toBeVisible();
        } else {
          await page.getByRole("button", { name: "Dismiss", exact: true }).click();
          await expect(page.getByText("Dismissed", { exact: true })).toBeVisible();
        }
        await expect(page.locator("[data-chat-pending-card]")).toHaveCount(0);
        const latest = page.getByRole("button", { name: "Jump to the latest message" });
        if (await latest.isVisible()) await latest.click();
        await expect(jump).toHaveCount(0);
      });
    }
  });
}
