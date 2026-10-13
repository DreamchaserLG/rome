import { describe, expect, it } from "@rstest/core";
import {
  findDeclaredRemovals,
  type MigrationSql,
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

function check(shipped: Record<string, string[]>, ...migrations: MigrationSql[]) {
  return findDeclaredRemovals({
    shippedSnapshot: snapshot(shipped),
    unshippedMigrations: migrations,
  });
}

function migration(name: string, ...statements: string[]): MigrationSql {
  return { name, sql: statements.join("\n--> statement-breakpoint\n") };
}

describe("findDeclaredRemovals", () => {
  it("flags a dropped table the last release still declares", () => {
    // The shape v1.1.146 shipped and v1.1.147 removed, reduced to what the check reads.
    const removals = check(
      { settings: ["key", "value"], provider_accounts: ["id", "provider", "token"] },
      migration(
        "0072_drop_provider_accounts",
        "DROP TABLE `provider_accounts`;",
        "DELETE FROM `settings` WHERE `key` = 'telegram';",
      ),
    );

    expect(removals).toEqual([
      { table: "provider_accounts", migrations: ["0072_drop_provider_accounts"] },
    ]);
  });

  it("passes a drop once the last release stopped declaring the table", () => {
    const removals = check(
      { settings: ["key", "value"] },
      migration("0072_drop_provider_accounts", "DROP TABLE `provider_accounts`;"),
    );

    expect(removals).toEqual([]);
  });

  it("passes the release that stops declaring an object while a no-op migration keeps it", () => {
    const removals = check(
      { routines: ["id", "legacy_trigger"], provider_accounts: ["id"] },
      migration("0088_stop_declaring", "SELECT 1;"),
    );

    expect(removals).toEqual([]);
  });

  it("flags dropped and renamed columns the last release declares", () => {
    const removals = check(
      { outbox: ["id", "payload", "legacy_target"] },
      migration(
        "0081_custom",
        "ALTER TABLE `outbox` DROP COLUMN `legacy_target`;",
        'ALTER TABLE "outbox" RENAME COLUMN "payload" TO "body";',
      ),
    );

    expect(removals).toEqual([
      { table: "outbox", column: "legacy_target", migrations: ["0081_custom"] },
      { table: "outbox", column: "payload", migrations: ["0081_custom"] },
    ]);
  });

  it("passes a column drop once the last release stopped declaring the column", () => {
    const removals = check(
      { routines: ["id"] },
      migration("0089_drop_legacy_trigger", "ALTER TABLE `routines` DROP COLUMN `legacy_trigger`;"),
    );

    expect(removals).toEqual([]);
  });

  it("flags a renamed table as the removal of its old name", () => {
    const removals = check(
      { events: ["id"] },
      migration("0082_rename_events", "ALTER TABLE `events` RENAME TO `routines`;"),
    );

    expect(removals).toEqual([{ table: "events", migrations: ["0082_rename_events"] }]);
  });

  it("matches schema-qualified and differently cased names", () => {
    const removals = check(
      { routines: ["id", "name"], outbox: ["id", "body"] },
      migration(
        "0087_custom",
        "DROP TABLE main.ROUTINES;",
        'ALTER TABLE "main"."OUTBOX" DROP COLUMN BODY;',
      ),
    );

    expect(removals).toEqual([
      { table: "routines", migrations: ["0087_custom"] },
      { table: "outbox", column: "body", migrations: ["0087_custom"] },
    ]);
  });

  it("ignores comments, and reads statements after a comment marker inside a string", () => {
    const removals = check(
      { routines: ["id", "name"] },
      migration(
        "0090_custom",
        "-- DROP TABLE `routines`; a comment, not a statement",
        "UPDATE `routines` SET `name` = '/*';",
        "ALTER TABLE `routines` DROP COLUMN `name`;",
        "SELECT 1; -- */",
      ),
    );

    expect(removals).toEqual([{ table: "routines", column: "name", migrations: ["0090_custom"] }]);
  });

  it("reads single-quoted names, which SQLite accepts as identifiers", () => {
    const removals = check(
      { routines: ["id", "name"], outbox: ["id", "body"] },
      migration("0091_custom", "DROP TABLE 'routines';", "ALTER TABLE outbox DROP COLUMN 'body';"),
    );

    expect(removals).toEqual([
      { table: "routines", migrations: ["0091_custom"] },
      { table: "outbox", column: "body", migrations: ["0091_custom"] },
    ]);
  });

  it("ignores dropped indexes, which no older reader depends on", () => {
    const removals = check(
      { rome_sessions: ["id", "type"] },
      migration(
        "0078_webchat_chats_as_channel_rows",
        "DROP INDEX IF EXISTS `rome_sessions_webchat_idx`;",
        "UPDATE `rome_sessions` SET `type` = 'channel';",
      ),
    );

    expect(removals).toEqual([]);
  });

  it("ignores tables the last release did not declare", () => {
    const removals = check(
      { settings: ["key"] },
      migration("0083_scratch", "CREATE TABLE `scratch` (`id` text);", "DROP TABLE `scratch`;"),
    );

    expect(removals).toEqual([]);
  });
});

describe("findDeclaredRemovals on table rebuilds", () => {
  const drizzleRebuild = (copied: string) =>
    migration(
      "0080_rebuild_routines",
      "PRAGMA foreign_keys=OFF;",
      "CREATE TABLE `__new_routines` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `paused` integer DEFAULT 0 NOT NULL);",
      `INSERT INTO \`__new_routines\`(${copied}) SELECT ${copied} FROM \`routines\`;`,
      "DROP TABLE `routines`;",
      "ALTER TABLE `__new_routines` RENAME TO `routines`;",
      "PRAGMA foreign_keys=ON;",
    );

  it("passes a drizzle rebuild that copies every shipped column", () => {
    expect(check({ routines: ["id", "name"] }, drizzleRebuild('"id", "name"'))).toEqual([]);
  });

  it("flags a column a drizzle rebuild leaves out", () => {
    expect(
      check({ routines: ["id", "name", "legacy_trigger"] }, drizzleRebuild('"id", "name"')),
    ).toEqual([
      { table: "routines", column: "legacy_trigger", migrations: ["0080_rebuild_routines"] },
    ]);
  });

  it("flags a column a hand-written rebuild leaves out", () => {
    const removals = check(
      { routines: ["id", "name"] },
      migration(
        "0083_rebuild_routines",
        "CREATE TABLE `routines_new` (`id` text PRIMARY KEY NOT NULL);",
        'INSERT INTO `routines_new` ("id") SELECT "id" FROM `routines`;',
        "DROP TABLE `routines`;",
        "ALTER TABLE `routines_new` RENAME TO `routines`;",
      ),
    );

    expect(removals).toEqual([
      { table: "routines", column: "name", migrations: ["0083_rebuild_routines"] },
    ]);
  });

  it("flags a column the copy loses before it takes the table's name", () => {
    const removals = check(
      { routines: ["id", "name"] },
      migration(
        "0084_rebuild_routines",
        "CREATE TABLE `routines_new` (`id` text PRIMARY KEY NOT NULL, `name` text);",
        'INSERT INTO `routines_new` ("id", "name") SELECT "id", "name" FROM `routines`;',
        "ALTER TABLE `routines_new` DROP COLUMN `name`;",
        "DROP TABLE `routines`;",
        "ALTER TABLE `routines_new` RENAME TO `routines`;",
      ),
    );

    expect(removals).toEqual([
      { table: "routines", column: "name", migrations: ["0084_rebuild_routines"] },
    ]);
  });

  it("pairs each of two rebuilds of one table with its own copy", () => {
    const removals = check(
      { routines: ["id", "name"] },
      migration(
        "0085_rebuild_twice",
        "CREATE TABLE `a` (`id` text, `name` text);",
        'INSERT INTO `a` ("id", "name") SELECT "id", "name" FROM `routines`;',
        "DROP TABLE `routines`;",
        "ALTER TABLE `a` RENAME TO `routines`;",
        "CREATE TABLE `b` (`id` text);",
        'INSERT INTO `b` ("id") SELECT "id" FROM `routines`;',
        "DROP TABLE `routines`;",
        "ALTER TABLE `b` RENAME TO `routines`;",
      ),
    );

    expect(removals).toEqual([
      { table: "routines", column: "name", migrations: ["0085_rebuild_twice"] },
    ]);
  });

  it("passes a rebuild that renames the table away and creates it again", () => {
    const removals = check(
      { routines: ["id", "name"] },
      migration(
        "0086_rebuild_routines",
        "ALTER TABLE `routines` RENAME TO `routines_old`;",
        "CREATE TABLE `routines` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL);",
        'INSERT INTO `routines` ("id", "name") SELECT "id", "name" FROM `routines_old`;',
        "DROP TABLE `routines_old`;",
      ),
    );

    expect(removals).toEqual([]);
  });

  it("flags the table when a rebuild's copy statement names no columns", () => {
    const removals = check(
      { routines: ["id", "name"] },
      migration(
        "0087_rebuild_routines",
        "CREATE TABLE `routines_new` (`id` text PRIMARY KEY NOT NULL, `name` text);",
        "INSERT INTO `routines_new` SELECT * FROM `routines`;",
        "DROP TABLE `routines`;",
        "ALTER TABLE `routines_new` RENAME TO `routines`;",
      ),
    );

    expect(removals).toEqual([{ table: "routines", migrations: ["0087_rebuild_routines"] }]);
  });

  it("flags a drop that comes after the rename onto the same name", () => {
    const removals = check(
      { routines: ["id"] },
      migration(
        "0088_misordered",
        "ALTER TABLE `routines_new` RENAME TO `routines`;",
        "DROP TABLE `routines`;",
      ),
    );

    expect(removals).toEqual([{ table: "routines", migrations: ["0088_misordered"] }]);
  });
});
