import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { LinkedAccount, PersonResource } from "@rome/api-types/people";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar } from "./avatar";
import { ChannelGlyph, ChannelPill, channelLabel } from "./channel-meta";
import { personPath } from "./people-model";
import { levelLabelKey } from "./rows";
import { accountHandle } from "./send-model";
import { MutationError } from "./triage";
import { useGuardian } from "./use-roster";
import { usePeopleWrites } from "./use-writes";

// The guardian in People: a row pinned above both views, and the paired
// accounts on their own page.
//
// A paired account is every People link to the guardian, however it was made,
// because each one carries guardian permissions in chat. The dashboard's own
// chat is the exception: it knows the guardian by their sign-in, not by a link,
// so a webchat account is not something Rome recognises them through and has
// nothing to unpair.

/** The guardian's accounts that Rome recognises them through in chat. */
export function pairedAccounts(person: PersonResource): LinkedAccount[] {
  return person.accounts.filter((account) => account.channel !== "webchat");
}

/** Your row, above both views. Nothing renders until the read answers, and an
 *  instance with no guardian person has no row to pin. */
export function GuardianRow() {
  const { t } = useTranslation("people");
  const navigate = useNavigate();
  const location = useLocation();
  const guardian = useGuardian().data;
  if (!guardian) return null;
  const paired = pairedAccounts(guardian);

  return (
    <section
      aria-label={t("you.label")}
      className="flex flex-wrap items-center gap-3 rounded-12 border border-border bg-surface p-3"
    >
      <Avatar name={guardian.displayName} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-ui font-medium text-foreground">
            {guardian.displayName}
          </span>
          <Badge variant="outline">
            {t("you.label")} · {t(levelLabelKey("guardian"))}
          </Badge>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-aux text-muted-foreground">
          {paired.length === 0 ? (
            t("you.notRecognised")
          ) : (
            <>
              {t("you.recognisedOn")}
              {[...new Set(paired.map((account) => account.channel))].map((channel) => (
                <ChannelPill key={channel} channel={channel} />
              ))}
            </>
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          navigate(personPath(guardian.id), {
            state: { from: `${location.pathname}${location.search}` },
          })
        }
      >
        {t("you.pairedAccounts")}
      </Button>
    </section>
  );
}

/** The guardian's page: every paired account, and Unpair on each. */
export function PairedAccounts({ person }: { person: PersonResource }) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const [unpairing, setUnpairing] = useState<LinkedAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paired = pairedAccounts(person);

  async function unpair(account: LinkedAccount) {
    setUnpairing(null);
    setError(null);
    const result = await writes.unlink(person.id, account);
    if (!result.ok) setError("conflict" in result ? result.conflict.error : result.message);
  }

  const channel = unpairing ? channelLabel(t, unpairing.channel) : "";

  return (
    <section aria-labelledby="paired-accounts" className="space-y-2">
      <h2 id="paired-accounts" className="text-section text-foreground">
        {t("you.pairedAccounts")}
      </h2>
      <p className="text-aux text-muted-foreground">{t("paired.description")}</p>
      <ul className="divide-y divide-border rounded-12 border border-border bg-surface">
        {paired.map((account) => (
          <li
            key={`${account.channel}:${account.channelUserId}`}
            className="flex items-center gap-3 px-4 py-3"
          >
            <ChannelGlyph channel={account.channel} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-ui text-foreground">
                {channelLabel(t, account.channel)} · {account.displayName}
              </p>
              <p className="truncate font-mono text-aux tabular-nums text-muted-foreground">
                {accountHandle(account)}
              </p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setUnpairing(account)}>
              {t("paired.unpair")}
            </Button>
          </li>
        ))}
        <li className="px-4 py-3 text-aux text-muted-foreground">
          {paired.length === 0 ? `${t("paired.empty")} ` : ""}
          {t("paired.howToPair")}
        </li>
      </ul>
      <MutationError message={error} />

      <RomeConfirmDialog
        open={unpairing !== null}
        destructive
        title={t("paired.confirmTitle", { channel })}
        description={t("paired.confirmBody", {
          channel,
          account: unpairing ? accountHandle(unpairing) : "",
        })}
        confirmLabel={t("paired.unpair")}
        cancelLabel={t("actions.cancel")}
        onCancel={() => setUnpairing(null)}
        onConfirm={() => unpairing && void unpair(unpairing)}
      />
    </section>
  );
}
