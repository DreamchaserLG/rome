import { describe, expect, it } from "@rstest/core";
import type { ChannelRecord } from "../db/repositories/channel-records.js";
import { withLinkedAgent } from "./linked-agents.js";

describe("withLinkedAgent", () => {
  it("reads the linked agent from the record each time it is asked", () => {
    let agent: string | null = "sales:agent";
    const records = {
      byName: (name: string) =>
        name === "feishu-2" ? ({ name, agent } as unknown as ChannelRecord) : null,
    };
    const channel = withLinkedAgent({ name: "feishu-2" }, records) as {
      name: string;
      linkedAgent?: string | null;
    };

    expect(channel.linkedAgent).toBe("sales:agent");
    agent = null;
    expect(channel.linkedAgent).toBeNull();
    expect(
      (withLinkedAgent({ name: "whatsapp" }, records) as { linkedAgent?: string | null })
        .linkedAgent,
    ).toBeNull();
  });
});
