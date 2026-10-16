/**
 * Card interactions run app actions. A card control whose `value` names an
 * action under `CARD_ACTION_KEY` runs that action when a person acts on it,
 * provided the action declares `interactions: true`. The action hears who
 * acted through its channel context, the way a message's sender reaches an
 * agent turn. Contract: docs/architecture/channels.md#card-interactions.
 */

import {
  CARD_ACTION_KEY,
  type ActionEngineLike,
  type ChannelInteractionActionInput,
  type InboundInteractionEvent,
} from "@rome-os/app-runtime";
import { createLogger } from "../logger.js";
import type { Channel } from "./channel.js";

const log = createLogger("channel-interactions");

export interface InteractionActionsDeps {
  channels: readonly Pick<Channel, "name" | "inbound">[];
  /** Reads an action's declared config (`action.yaml`) by name. */
  actions: { get(name: string): { interactions?: boolean } | undefined };
  actionEngine: ActionEngineLike;
}

/** Subscribes to every channel's interactions and returns the unsubscribe. */
export function routeInteractionsToActions(deps: InteractionActionsDeps): () => void {
  const unsubscribes = deps.channels.flatMap((channel) => {
    const interactions = channel.inbound?.interactions;
    if (!interactions) return [];
    return [interactions.subscribe((event) => runInteractionAction(deps, event))];
  });
  return () => unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe());
}

/** The action a card control names, or null when it names none. */
export function interactionActionName(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const name = (value as Record<string, unknown>)[CARD_ACTION_KEY];
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

export async function runInteractionAction(
  deps: Pick<InteractionActionsDeps, "actions" | "actionEngine">,
  event: InboundInteractionEvent,
): Promise<void> {
  const { interaction, ref } = event;
  const actionName = interactionActionName(interaction.action.value);
  if (!actionName) return;
  if (!deps.actions.get(actionName)?.interactions) {
    log.warn("card interaction names an action that does not accept interactions", {
      channel: interaction.channel,
      actionName,
      messageId: interaction.messageId,
    });
    return;
  }
  const input: ChannelInteractionActionInput = {
    interaction: {
      channel: interaction.channel,
      connectionId: ref.connectionId,
      conversationId: interaction.conversationId,
      messageId: interaction.messageId,
      senderId: interaction.senderId,
      ...(interaction.senderDisplayName
        ? { senderDisplayName: interaction.senderDisplayName }
        : {}),
      action: interaction.action,
      timestamp: interaction.timestamp.toISOString(),
    },
  };
  try {
    const result = await deps.actionEngine.run(
      actionName,
      input as unknown as Record<string, unknown>,
      {
        initiator: `connection:${ref.connectionId}`,
        channelContext: {
          connectionId: ref.connectionId,
          channel: interaction.channel,
          threadId: interaction.conversationId,
          channelUserId: interaction.senderId,
        },
      },
    );
    if (result.status === "error") {
      log.warn("card interaction action failed", {
        actionName,
        messageId: interaction.messageId,
        error: result.error,
      });
    }
  } catch (err) {
    log.error("card interaction action threw", {
      actionName,
      messageId: interaction.messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
