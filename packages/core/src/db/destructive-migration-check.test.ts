import { describe, expect, it } from "@rstest/core";
import {
  findUnretiredRemovals,
  parseRetiredManifest,
  type SchemaSnapshot,
} from "./destructive-migration-check.js";

function snapshot(tables: Record<string, string[]>): SchemaSnapshot {
  return {
    tables: Object.fromEntries(
      Object.entries(tables).map(([name, columns]) => [
        name,
        { columns: Object.fromEntries(columns.map((column) => [column, { name: column }])) },
      ]),
    ),
  };
}

// The shape v1.1.146 shipped and v1.1.147 removed, reduced to what the check reads.
const shippedWithProviderAccounts = snapshot({
  settings: ["key", "value"],
  provider_accounts: ["id", "provider", "token"],
});
const headWithoutProviderAccounts = snapshot({ settings: ["key", "value"] });
const dropProviderAccounts = {
  name: "0072_drop_provider_accounts",
  sql: "DROP TABLE `provider_accounts`;\n--> statement-breakpoint\nDELETE FROM `settings` WHERE `key` = 'telegram';",
};

describe("findUnretiredRemovals", () => {
  it("flags a dropped table the last release still declares and never retired", () => {
    const violations = findUnretiredRemovals({
      shippedSnapshot: shippedWithProviderAccounts,
      headSnapshot: headWithoutProviderAccounts,
      unshippedMigrations: [dropProviderAccounts],
      shippedRetired: [],
    });

    expect(violations).toEqual([
      {
        table: "provider_accounts",
        foundIn: ["schema", "0072_drop_provider_accounts"],
      },
    ]);
  });

  it("allows the drop once a shipped release retired the table", () => {
    const violations = findUnretiredRemovals({
      shippedSnapshot: shippedWithProviderAccounts,
      headSnapshot: headWithoutProviderAccounts,
      unshippedMigrations: [dropProviderAccounts],
      shippedRetired: [{ table: "provider_accounts" }],
    });

    expect(violations).toEqual([]);
  });

  it("flags the drop when the table was retired in the same unreleased change", () => {
    // The incident shape: the reader removal, the retirement and the drop all
    // land before a release, so no shipped manifest lists the table. The caller
    // passes the manifest as the last release tag had it, which is empty here
    // even though HEAD's manifest names provider_accounts.
    const violations = findUnretiredRemovals({
      shippedSnapshot: shippedWithProviderAccounts,
      headSnapshot: headWithoutProviderAccounts,
      unshippedMigrations: [dropProviderAccounts],
      shippedRetired: [],
    });

    expect(violations.map((violation) => violation.table)).toEqual(["provider_accounts"]);
  });

  it("flags a column removed through drizzle's table recreate", () => {
    const violations = findUnretiredRemovals({
      shippedSnapshot: snapshot({ routines: ["id", "name", "legacy_trigger"] }),
      headSnapshot: snapshot({ routines: ["id", "name"] }),
      unshippedMigrations: [
        {
          name: "0080_drop_legacy_trigger",
          sql: [
            "PRAGMA foreign_keys=OFF;--> statement-breakpoint",
            "CREATE TABLE `__new_routines` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL);",
            "--> statement-breakpoint",
            'INSERT INTO `__new_routines`("id", "name") SELECT "id", "name" FROM `routines`;--> statement-breakpoint',
            "DROP TABLE `routines`;--> statement-breakpoint",
            "ALTER TABLE `__new_routines` RENAME TO `routines`;--> statement-breakpoint",
            "PRAGMA foreign_keys=ON;",
          ].join("\n"),
        },
      ],
      shippedRetired: [],
    });

    expect(violations).toEqual([
      { table: "routines", column: "legacy_trigger", foundIn: ["schema"] },
    ]);
  });

  it("treats a hand-written rebuild that renames a copy onto the table as no removal", () => {
    const violations = findUnretiredRemovals({
      shippedSnapshot: snapshot({ routines: ["id", "name"] }),
      headSnapshot: snapshot({ routines: ["id", "name"] }),
      unshippedMigrations: [
        {
          name: "0083_rebuild_routines",
          sql: [
            "CREATE TABLE `routines_new` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL UNIQUE);",
            'INSERT INTO `routines_new` SELECT "id", "name" FROM `routines`;',
            "DROP TABLE `routines`;",
            "ALTER TABLE `routines_new` RENAME TO `routines`;",
          ].join("\n"),
        },
      ],
      shippedRetired: [],
    });

    expect(violations).toEqual([]);
  });

  it("treats a rebuild that renames the table away and creates it again as no removal", () => {
    const violations = findUnretiredRemovals({
      shippedSnapshot: snapshot({ routines: ["id", "name"] }),
      headSnapshot: snapshot({ routines: ["id", "name"] }),
      unshippedMigrations: [
        {
          name: "0084_rebuild_routines",
          sql: [
            "ALTER TABLE `routines` RENAME TO `routines_old`;",
            "CREATE TABLE `routines` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL);",
            'INSERT INTO `routines` SELECT "id", "name" FROM `routines_old`;',
            "DROP TABLE `routines_old`;",
          ].join("\n"),
        },
      ],
      shippedRetired: [],
    });

    expect(violations).toEqual([]);
  });

  it("flags a drop that comes after the rename onto the same name", () => {
    const violations = findUnretiredRemovals({
      shippedSnapshot: snapshot({ routines: ["id"] }),
      headSnapshot: snapshot({ routines: ["id"] }),
      unshippedMigrations: [
        {
          name: "0085_misordered",
          sql: "ALTER TABLE `routines_new` RENAME TO `routines`;\nDROP TABLE `routines`;",
        },
      ],
      shippedRetired: [],
    });

    expect(violations).toEqual([{ table: "routines", foundIn: ["0085_misordered"] }]);
  });

  it("does not let a retired column cover its whole table", () => {
    const violations = findUnretiredRemovals({
      shippedSnapshot: shippedWithProviderAccounts,
      headSnapshot: headWithoutProviderAccounts,
      unshippedMigrations: [],
      shippedRetired: [{ table: "provider_accounts", column: "token" }],
    });

    expect(violations).toEqual([{ table: "provider_accounts", foundIn: ["schema"] }]);
  });

  it("lets a retired table cover its columns", () => {
    const violations = findUnretiredRemovals({
      shippedSnapshot: snapshot({ routines: ["id", "legacy_trigger"] }),
      headSnapshot: snapshot({ routines: ["id"] }),
      unshippedMigrations: [],
      shippedRetired: [{ table: "routines" }],
    });

    expect(violations).toEqual([]);
  });

  it("ignores dropped indexes, which no older reader depends on", () => {
    const violations = findUnretiredRemovals({
      shippedSnapshot: snapshot({ rome_sessions: ["id", "type"] }),
      headSnapshot: snapshot({ rome_sessions: ["id", "type"] }),
      unshippedMigrations: [
        {
          name: "0078_webchat_chats_as_channel_rows",
          sql: "DROP INDEX IF EXISTS `rome_sessions_webchat_idx`;--> statement-breakpoint\nUPDATE `rome_sessions` SET `type` = 'channel';",
        },
      ],
      shippedRetired: [],
    });

    expect(violations).toEqual([]);
  });

  it("catches a hand-written drop the schema still declares", () => {
    const violations = findUnretiredRemovals({
      shippedSnapshot: snapshot({ outbox: ["id", "payload", "legacy_target"] }),
      headSnapshot: snapshot({ outbox: ["id", "payload", "legacy_target"] }),
      unshippedMigrations: [
        {
          name: "0081_custom",
          sql: [
            "-- DROP TABLE `outbox`; a comment, not a statement",
            "ALTER TABLE `outbox` DROP COLUMN `legacy_target`;",
            'ALTER TABLE "outbox" RENAME COLUMN "payload" TO "body";',
          ].join("\n"),
        },
      ],
      shippedRetired: [],
    });

    expect(violations).toEqual([
      { table: "outbox", column: "legacy_target", foundIn: ["0081_custom"] },
      { table: "outbox", column: "payload", foundIn: ["0081_custom"] },
    ]);
  });

  it("flags a renamed table as the removal of its old name", () => {
    const violations = findUnretiredRemovals({
      shippedSnapshot: snapshot({ events: ["id"] }),
      headSnapshot: snapshot({ routines: ["id"] }),
      unshippedMigrations: [
        { name: "0082_rename_events", sql: "ALTER TABLE `events` RENAME TO `routines`;" },
      ],
      shippedRetired: [],
    });

    expect(violations).toEqual([{ table: "events", foundIn: ["schema", "0082_rename_events"] }]);
  });

  it("ignores tables no shipped release declared", () => {
    const violations = findUnretiredRemovals({
      shippedSnapshot: snapshot({ settings: ["key"] }),
      headSnapshot: snapshot({ settings: ["key"] }),
      unshippedMigrations: [
        { name: "0083_scratch", sql: "CREATE TABLE `scratch` (`id` text);\nDROP TABLE `scratch`;" },
      ],
      shippedRetired: [],
    });

    expect(violations).toEqual([]);
  });
});

describe("parseRetiredManifest", () => {
  it("reads table and column entries", () => {
    expect(
      parseRetiredManifest(
        JSON.stringify({
          retired: [{ table: "provider_accounts" }, { table: "routines", column: "legacy" }],
        }),
      ),
    ).toEqual([{ table: "provider_accounts" }, { table: "routines", column: "legacy" }]);
  });

  it("treats a release without the manifest as retiring nothing", () => {
    expect(parseRetiredManifest(null)).toEqual([]);
  });

  it("rejects an entry without a table", () => {
    expect(() => parseRetiredManifest(JSON.stringify({ retired: [{ column: "x" }] }))).toThrow();
  });
});
