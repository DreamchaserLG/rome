import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createConnection } from "@/lib/connections-api";
import type { ConnectionCard } from "@/lib/connection-cards";

/**
 * Account controls on a channel card: "Add another account" for services that
 * offer several. It acts on the account (the card's channel), not on a slot,
 * so it sits below the slot cards.
 */

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Whether the card's own Talk (not a folded personal-account slot) is connected. */
function talkConnected(card: ConnectionCard): boolean {
  return card.slots.some((slot) => slot.key !== "session" && slot.state !== "unauthorized");
}

export function AccountControls({
  card,
  onFlash,
  onOpenAccount,
}: {
  card: ConnectionCard;
  onFlash: (message: string) => void;
  /** Open another account's card by its route. Without it, the add button is hidden. */
  onOpenAccount?: (route: string) => void | Promise<void>;
}) {
  const connected = talkConnected(card);
  // A second account only makes sense next to a first one that exists.
  const showAdd = card.severalAccounts && connected && onOpenAccount !== undefined;
  if (!showAdd) return null;

  return (
    <div className="space-y-4">
      {showAdd && onOpenAccount && (
        <AddAccountButton service={card.service} onFlash={onFlash} onOpenAccount={onOpenAccount} />
      )}
    </div>
  );
}

function AddAccountButton({
  service,
  onFlash,
  onOpenAccount,
}: {
  service: string;
  onFlash: (message: string) => void;
  onOpenAccount: (route: string) => void | Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const [adding, setAdding] = useState(false);

  const add = async () => {
    setAdding(true);
    try {
      const connection = await createConnection(service);
      await onOpenAccount(connection.channel || connection.service);
    } catch (error) {
      onFlash(errorMessage(error, t("connections.accounts.addFailed")));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Button type="button" variant="outline" disabled={adding} onClick={() => void add()}>
      <Plus data-icon="inline-start" aria-hidden />
      {t("connections.accounts.add")}
    </Button>
  );
}
