// Rollback-safety check for system migrations. The rule it enforces, and the
// two-release sequence that satisfies it, are in DEVELOPMENT.md under
// "Established patterns". The CLI that feeds it from git lives in
// src/bin/check-destructive-migrations.ts.
import { z } from "zod";

/** The part of a drizzle-kit snapshot (`meta/NNNN_snapshot.json`) the check reads. */
export interface SchemaSnapshot {
  tables: Record<string, { columns: Record<string, unknown> }>;
}

/**
 * An object whose last reader is gone. A table entry covers every column of
 * the table. A column entry covers only that column, never its table.
 */
export interface RetiredEntry {
  table: string;
  column?: string;
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
  retired: z.array(z.object({ table: z.string().min(1), column: z.string().min(1).optional() })),
});

/**
 * Parses `drizzle/system/retired.json`. Null, for a release that predates the
 * manifest, means nothing was retired. Throws on a malformed manifest.
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
 * Removals come from two sources. The snapshot diff covers drops, renames and
 * drizzle's `__new_<table>` recreates. The SQL scan covers hand-written drops
 * and renames in migrations the last release did not ship. Index drops are
 * ignored, since no reader fails when an index is gone. Only objects the last
 * release declares count, so an object created and dropped before a release
 * passes.
 */
export function findUnretiredRemovals(input: {
  shippedSnapshot: SchemaSnapshot;
  headSnapshot: SchemaSnapshot;
  unshippedMigrations: readonly MigrationSql[];
  shippedRetired: readonly RetiredEntry[];
}): UnretiredRemoval[] {
  const { shippedSnapshot, headSnapshot, unshippedMigrations, shippedRetired } = input;
  const removals = new Map<string, UnretiredRemoval>();
  const record = (table: string, column: string | undefined, foundIn: string) => {
    const shippedTable = shippedSnapshot.tables[table];
    if (!shippedTable) return;
    if (column !== undefined && !(column in shippedTable.columns)) return;
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

  for (const [table, shippedTable] of Object.entries(shippedSnapshot.tables)) {
    const headTable = headSnapshot.tables[table];
    if (!headTable) {
      record(table, undefined, "schema");
      continue;
    }
    for (const column of Object.keys(shippedTable.columns)) {
      if (!(column in headTable.columns)) record(table, column, "schema");
    }
  }

  for (const migration of unshippedMigrations) {
    for (const removal of scanSqlForRemovals(migration.sql)) {
      record(removal.table, removal.column, migration.name);
    }
  }

  const isRetired = (removal: UnretiredRemoval) =>
    shippedRetired.some(
      (entry) =>
        entry.table === removal.table &&
        (entry.column === undefined || entry.column === removal.column),
    );
  return [...removals.values()].filter((removal) => !isRetired(removal));
}

const IDENT = String.raw`[\`"\[]?([A-Za-z_][\w$]*)[\`"\]]?`;
const DROP_TABLE = new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENT}`, "gi");
const DROP_COLUMN = new RegExp(
  String.raw`\bALTER\s+TABLE\s+${IDENT}\s+DROP\s+(?:COLUMN\s+)?${IDENT}`,
  "gi",
);
const RENAME_TABLE = new RegExp(
  String.raw`\bALTER\s+TABLE\s+${IDENT}\s+RENAME\s+TO\s+${IDENT}`,
  "gi",
);
const RENAME_COLUMN = new RegExp(
  String.raw`\bALTER\s+TABLE\s+${IDENT}\s+RENAME\s+(?:COLUMN\s+)?(?!TO\b)${IDENT}\s+TO\s+${IDENT}`,
  "gi",
);
const RECREATE_PREFIX = "__new_";

function scanSqlForRemovals(sql: string): { table: string; column?: string }[] {
  const code = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

  // drizzle-kit recreates a table to change it: it copies the rows into
  // `__new_<table>`, drops the original, then renames the copy back. The table
  // survives, and any column the copy leaves out shows in the snapshot diff.
  const recreated = new Set<string>();
  for (const [, from, to] of code.matchAll(RENAME_TABLE)) {
    if (from === `${RECREATE_PREFIX}${to}`) recreated.add(to);
  }

  const removals: { table: string; column?: string }[] = [];
  for (const [, table] of code.matchAll(DROP_TABLE)) {
    if (!recreated.has(table)) removals.push({ table });
  }
  for (const [, from] of code.matchAll(RENAME_TABLE)) {
    if (!from.startsWith(RECREATE_PREFIX)) removals.push({ table: from });
  }
  for (const [, table, column] of code.matchAll(DROP_COLUMN)) {
    removals.push({ table, column });
  }
  for (const [, table, column] of code.matchAll(RENAME_COLUMN)) {
    removals.push({ table, column });
  }
  return removals;
}
