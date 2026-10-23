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

    for (const kind of ["routine", "plan", "question", "ai"] satisfies WaitingCardKind[]) {
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
        const scroller = page
          .locator("[data-chat-transcript]")
          .locator("xpath=ancestor::*[contains(@class, 'overflow-y-auto')][1]");
        const center = await page.locator("[data-chat-composer-box]").evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left + rect.width / 2;
        });
        await expect
          .poll(async () => {
            const box = (await jump.boundingBox())!;
            return Math.abs(box.x + box.width / 2 - center);
          })
          .toBeLessThan(1);
        await jump.focus();
        await page.keyboard.press("Enter");
        await expect(card).toBeInViewport();
        await expect(card).toBeFocused();
        expect(await card.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
        expect(
          await card.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth)),
        ).toBeGreaterThan(0);
        await expect(jump).toHaveCount(0);
        await page.screenshot({
          path: test.info().outputPath(`${kind}-${viewport.name}-card.png`),
        });
        await scroller.evaluate(
          (el, delta) => el.scrollBy({ top: delta, behavior: "instant" }),
          (await card.boundingBox())!.height + 24,
        );
        await expect(jump).toBeVisible();
        const latest = page.getByRole("button", { name: "Jump to the latest message" });
        await expect
          .poll(async () => {
            const box = (await latest.boundingBox())!;
            return Math.abs(box.x + box.width / 2 - center);
          })
          .toBeLessThan(1);
        await latest.click();
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
        } else if (kind === "ai") {
          await page.getByRole("button", { name: "Skip for now", exact: true }).click();
          await expect(page.getByText("Skipped for now", { exact: true })).toBeVisible();
        } else {
          await page.getByRole("button", { name: "Dismiss", exact: true }).click();
          await expect(page.getByText("Dismissed", { exact: true })).toBeVisible();
        }
        await expect(page.locator("[data-chat-pending-card]")).toHaveCount(0);
        await page.locator("[data-chat-transcript]").evaluate((el) => {
          const scroller = el.closest<HTMLElement>(".overflow-y-auto")!;
          scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
        });
        await expect(jump).toHaveCount(0);
      });
    }
  });
}

for (const kind of ["routine", "app"] as const) {
  for (const followUp of ["text", "proposal"] as const) {
    test(`${kind}: ${followUp === "text" ? "ignored" : "replaced"} proposals do not keep the reminder on the old card`, async ({
      page,
    }) => {
      await openWaitingCard(page, kind, followUp);
      const cards = page.locator("[data-chat-pending-card=proposal]");
      await expect(cards).toHaveCount(followUp === "text" ? 1 : 2);
      const jump = page.getByRole("button", { name: "Jump to waiting card" });
      if (followUp === "text") {
        await expect(page.locator("[data-chat-composer-box]")).toBeVisible();
        await expect(cards.first()).not.toBeInViewport();
        await expect(jump).toHaveCount(0);
        await page.reload({ waitUntil: "commit" });
        await expect(cards).toHaveCount(1);
        await expect(jump).toHaveCount(0);
      } else {
        await expect(jump).toBeVisible();
        await jump.click();
        await expect(cards.last()).toBeInViewport();
        await expect(cards.first()).not.toBeInViewport();
      }
    });
  }
}
