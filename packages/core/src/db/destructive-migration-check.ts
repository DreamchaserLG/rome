// Rollback-safety check for system migrations. The rule it enforces, and the
// two-release sequences that satisfy it, are in DEVELOPMENT.md under
// "Established patterns". The CLI that feeds it from git lives in
// src/bin/check-destructive-migrations.ts.
import { z } from "zod";

/** The part of a drizzle-kit snapshot (`meta/NNNN_snapshot.json`) the check reads. */
export interface SchemaSnapshot {
  tables: Record<string, { columns: Record<string, unknown> }>;
}

/**
 * A table whose last reader is gone, which covers its columns too. Columns
 * cannot be retired this way: drizzle names every declared column in each
 * select and insert, so a release reads every column its schema declares.
 */
export interface RetiredEntry {
  table: string;
}

export interface MigrationSql {
  /** The migration's journal tag, e.g. `0072_drop_provider_accounts`. */
  name: string;
  sql: string;
}

/** A table, or a column when `column` is set, that the last release declares and HEAD removes. */
export interface UnretiredRemoval {
  table: string;
  column?: string;
  /** `"schema"` for the snapshot diff, otherwise the migration that drops or renames it. */
  foundIn: string[];
}

const retiredManifestSchema = z.object({
  retired: z.array(z.strictObject({ table: z.string().min(1) })),
});

/**
 * Parses `drizzle/system/retired.json`. Null, for a release that predates the
 * manifest, means nothing was retired. Throws on a malformed manifest,
 * including a column entry.
 */
export function parseRetiredManifest(json: string | null): RetiredEntry[] {
  if (json === null) return [];
  return retiredManifestSchema.parse(JSON.parse(json)).retired;
}

/**
 * Lists every table and column that the last release's schema declares, that
 * HEAD removes, and that the last release's manifest does not retire.
 *
 * Pass the snapshot and manifest as the last release tag has them, not as HEAD
 * has them. An entry added in the same unreleased change as the drop retires
 * nothing, because the release a rollback lands on still reads the object.
 *
 * Table removals come from the snapshot diff and from the SQL of migrations
 * the last release did not ship. Column removals come from that SQL only, so a
 * release can stop declaring a column while a no-op migration keeps it in the
 * database. A table rebuild removes every shipped column its copy statement
 * leaves out, and removes the table when no copy statement matches. Index
 * drops are ignored, since no reader fails when an index is gone. Only objects
 * the last release declares count, so an object created and dropped before a
 * release passes. Identifiers match case-insensitively, as in SQLite.
 */
export function findUnretiredRemovals(input: {
  shippedSnapshot: SchemaSnapshot;
  headSnapshot: SchemaSnapshot;
  unshippedMigrations: readonly MigrationSql[];
  shippedRetired: readonly RetiredEntry[];
}): UnretiredRemoval[] {
  const { shippedSnapshot, headSnapshot, unshippedMigrations, shippedRetired } = input;
  const shippedTables = new Map(
    Object.entries(shippedSnapshot.tables).map(([name, table]) => [
      name.toLowerCase(),
      {
        name,
        columns: new Map(
          Object.keys(table.columns).map((column) => [column.toLowerCase(), column]),
        ),
      },
    ]),
  );
  const headTables = new Set(Object.keys(headSnapshot.tables).map((name) => name.toLowerCase()));

  const removals = new Map<string, UnretiredRemoval>();
  const record = (tableName: string, columnName: string | undefined, foundIn: string) => {
    const shippedTable = shippedTables.get(tableName.toLowerCase());
    if (!shippedTable) return;
    const table = shippedTable.name;
    const column =
      columnName === undefined ? undefined : shippedTable.columns.get(columnName.toLowerCase());
    if (columnName !== undefined && column === undefined) return;
    const key = column === undefined ? table : `${table}.${column}`;
    const existing = removals.get(key);
    if (!existing) {
      removals.set(
        key,
        column === undefined
          ? { table, foundIn: [foundIn] }
          : { table, column, foundIn: [foundIn] },
      );
    } else if (!existing.foundIn.includes(foundIn)) {
      existing.foundIn.push(foundIn);
    }
  };

  for (const [key, shippedTable] of shippedTables) {
    if (!headTables.has(key)) record(shippedTable.name, undefined, "schema");
  }

  for (const migration of unshippedMigrations) {
    for (const effect of scanSqlForRemovals(migration.sql)) {
      if (effect.kind === "removal") {
        record(effect.table, effect.column, migration.name);
        continue;
      }
      const shippedTable = shippedTables.get(effect.table);
      for (const [key, column] of shippedTable?.columns ?? []) {
        if (!effect.keptColumns.has(key)) record(effect.table, column, migration.name);
      }
    }
  }

  const retiredTables = new Set(shippedRetired.map((entry) => entry.table.toLowerCase()));
  return [...removals.values()].filter(
    (removal) => !retiredTables.has(removal.table.toLowerCase()),
  );
}

type SqlEffect =
  | { kind: "removal"; table: string; column?: string }
  | { kind: "rebuild"; table: string; keptColumns: Set<string> };

const NAME = String.raw`[\`"\[]?([A-Za-z_][\w$]*)[\`"\]]?`;
// SQLite accepts a schema qualifier such as `main.` before a table name.
const TABLE = String.raw`(?:[\`"\[]?[A-Za-z_][\w$]*[\`"\]]?\s*\.\s*)?${NAME}`;
const DROP_TABLE = new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${TABLE}`, "gi");
const CREATE_TABLE = new RegExp(
  String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE}`,
  "gi",
);
const RENAME_TABLE = new RegExp(
  String.raw`\bALTER\s+TABLE\s+${TABLE}\s+RENAME\s+TO\s+${TABLE}`,
  "gi",
);
const DROP_COLUMN = new RegExp(
  String.raw`\bALTER\s+TABLE\s+${TABLE}\s+DROP\s+(?:COLUMN\s+)?${NAME}`,
  "gi",
);
const RENAME_COLUMN = new RegExp(
  String.raw`\bALTER\s+TABLE\s+${TABLE}\s+RENAME\s+(?:COLUMN\s+)?(?!TO\b)${NAME}\s+TO\s+${NAME}`,
  "gi",
);
// `INSERT INTO copy (columns) SELECT ... FROM source`, within one statement.
const COPY_ROWS = new RegExp(
  String.raw`\bINSERT\s+INTO\s+${TABLE}\s*\(([^)]*)\)\s*SELECT\b[^;]*?\bFROM\s+${TABLE}`,
  "gi",
);

function scanSqlForRemovals(sql: string): SqlEffect[] {
  const code = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  const lower = (name: string) => name.toLowerCase();

  const drops = [...code.matchAll(DROP_TABLE)].map((m) => ({ table: lower(m[1]), at: m.index }));
  const creates = [...code.matchAll(CREATE_TABLE)].map((m) => ({
    table: lower(m[1]),
    at: m.index,
  }));
  const renames = [...code.matchAll(RENAME_TABLE)].map((m) => ({
    from: lower(m[1]),
    to: lower(m[2]),
    at: m.index,
  }));
  const copies = [...code.matchAll(COPY_ROWS)].map((m) => ({
    into: lower(m[1]),
    columns: new Set(
      m[2]
        .split(",")
        .map((column) => lower(column.trim().replace(/^[`"[]|[`"\]]$/g, "")))
        .filter(Boolean),
    ),
    from: lower(m[3]),
    at: m.index,
  }));

  // A SQLite table rebuild removes a table under its name, then gives the name
  // back to a copy of its rows. drizzle-kit fills `__new_t` from `t`, drops `t`
  // and renames the copy onto it. A hand-written rebuild may instead rename `t`
  // away, create `t` again and fill it from the old one. The rebuilt table keeps
  // only the columns its copy statement names.
  const effects: SqlEffect[] = [];
  for (const drop of drops) {
    const restore = renames.find((rename) => rename.to === drop.table && rename.at > drop.at);
    const copy =
      restore &&
      copies.find(
        (candidate) =>
          candidate.into === restore.from &&
          candidate.from === drop.table &&
          candidate.at < drop.at,
      );
    effects.push(
      copy
        ? { kind: "rebuild", table: drop.table, keptColumns: copy.columns }
        : { kind: "removal", table: drop.table },
    );
  }
  for (const rename of renames) {
    const recreate = creates.find(
      (create) => create.table === rename.from && create.at > rename.at,
    );
    const copy =
      recreate &&
      copies.find(
        (candidate) =>
          candidate.into === rename.from &&
          candidate.from === rename.to &&
          candidate.at > recreate.at,
      );
    effects.push(
      copy
        ? { kind: "rebuild", table: rename.from, keptColumns: copy.columns }
        : { kind: "removal", table: rename.from },
    );
  }
  for (const [, table, column] of code.matchAll(DROP_COLUMN)) {
    effects.push({ kind: "removal", table, column });
  }
  for (const [, table, column] of code.matchAll(RENAME_COLUMN)) {
    effects.push({ kind: "removal", table, column });
  }
  return effects;
}
