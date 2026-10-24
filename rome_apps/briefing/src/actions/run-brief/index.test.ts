import { describe, expect, it } from "@rstest/core";
import { DEFAULT_SETTINGS } from "../../db/repositories/settings.js";
import { buildPrompt, deliversToGuardian, suggestionsSection } from "./index.js";

describe("deliversToGuardian", () => {
  it("adds personal context only when the brief goes to the guardian", () => {
    const email = { ...DEFAULT_SETTINGS, channel: "email" };
    expect(deliversToGuardian({ ...email, emailTo: "guardian" }, true)).toBe(true);
    expect(deliversToGuardian({ ...email, emailTo: "" }, true)).toBe(true);
    expect(deliversToGuardian({ ...email, emailTo: "team@example.com" }, true)).toBe(false);
    expect(deliversToGuardian({ ...email, emailTo: "team@example.com" }, false)).toBe(true);
    const whatsapp = { ...DEFAULT_SETTINGS, channel: "whatsapp" };
    expect(deliversToGuardian({ ...whatsapp, whatsappThreadId: "" }, true)).toBe(true);
    expect(deliversToGuardian({ ...whatsapp, whatsappThreadId: "123@g.us" }, true)).toBe(false);
  });
});

describe("suggestionsSection", () => {
  it("reads the Try with Rome section wherever it sits", () => {
    expect(suggestionsSection("**Scouting**\nx\n\n**Try with Rome**\n- Track orders")).toBe(
      "- Track orders",
    );
    expect(suggestionsSection("**Try with Rome**\n- A\n\n**Calendar**\n- B")).toBe("- A");
    expect(suggestionsSection("**Summary**\nNothing")).toBeNull();
    expect(suggestionsSection(null)).toBeNull();
  });
});

describe("buildPrompt", () => {
  it("passes personal context only with the Try with Rome rules", () => {
    const context = { chats: 'Chat "Orders":\n- I sort these by hand', profile: "Name: Ada" };
    const prompt = buildPrompt("evening", "UTC", [], context, ["- Earlier idea"]);
    expect(prompt).toContain("I sort these by hand");
    expect(prompt).toContain("- Earlier idea");
    expect(prompt).toContain("last **Try with Rome** only when a suggestion qualifies");
    expect(prompt).not.toContain("${");

    const without = buildPrompt("evening", "UTC", [], null, []);
    expect(without).toContain("Leave this section out");
    expect(without).not.toContain("RECENT WEBCHAT MESSAGES");
  });
});
