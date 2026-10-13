// Rollback-safety check for system migrations. The rule it enforces, and the
// two-release sequence that satisfies it, are in DEVELOPMENT.md under
// "Established patterns". The CLI that feeds it from git lives in
// src/bin/check-destructive-migrations.ts.

/** The part of a drizzle-kit snapshot (`meta/NNNN_snapshot.json`) the check reads. */
export interface SchemaSnapshot {
  tables: Record<string, { columns: Record<string, unknown> }>;
}

export interface MigrationSql {
  /** The migration's journal tag, e.g. `0072_drop_provider_accounts`. */
  name: string;
  sql: string;
}

/** A table, or a column when `column` is set, that the last release declares and a migration removes. */
export interface DeclaredRemoval {
  table: string;
  column?: string;
  /** The migrations that drop or rename it. */
  migrations: string[];
}

/**
 * Lists every table and column that the last release's schema declares and
 * that a migration the last release did not ship drops or renames.
 *
 * drizzle names every declared column in each select and insert, so the last
 * release reads every table it queries and every column of it. An object is
 * safe to remove only once a release has stopped declaring it, and the
 * snapshot from that release no longer lists it.
 *
 * The SQL scan reads table and column drops and renames, with schema
 * qualifiers and case-insensitive names. A table rebuild removes every shipped
 * column its copy statement leaves out, and removes the table when no copy
 * statement matches. Index drops are ignored, since no reader fails when an
 * index is gone.
 */
export function findDeclaredRemovals(input: {
  shippedSnapshot: SchemaSnapshot;
  unshippedMigrations: readonly MigrationSql[];
}): DeclaredRemoval[] {
  const shippedTables = new Map(
    Object.entries(input.shippedSnapshot.tables).map(([name, table]) => [
      name.toLowerCase(),
      {
        name,
        columns: new Map(
          Object.keys(table.columns).map((column) => [column.toLowerCase(), column]),
        ),
      },
    ]),
  );

  const removals = new Map<string, DeclaredRemoval>();
  const record = (tableKey: string, columnKey: string | undefined, migration: string) => {
    const shippedTable = shippedTables.get(tableKey);
    if (!shippedTable) return;
    const table = shippedTable.name;
    const column = columnKey === undefined ? undefined : shippedTable.columns.get(columnKey);
    if (columnKey !== undefined && column === undefined) return;
    const key = column === undefined ? table : `${table}.${column}`;
    const existing = removals.get(key);
    if (!existing) {
      removals.set(
        key,
        column === undefined
          ? { table, migrations: [migration] }
          : { table, column, migrations: [migration] },
      );
    } else if (!existing.migrations.includes(migration)) {
      existing.migrations.push(migration);
    }
  };

  for (const migration of input.unshippedMigrations) {
    for (const effect of scanSqlForRemovals(migration.sql)) {
      if (effect.kind === "removal") {
        record(effect.table, effect.column, migration.name);
        continue;
      }
      for (const columnKey of shippedTables.get(effect.table)?.columns.keys() ?? []) {
        if (!effect.keptColumns.has(columnKey)) record(effect.table, columnKey, migration.name);
      }
    }
  }
  return [...removals.values()];
}

/** Names are lower-cased, since SQLite matches identifiers case-insensitively. */
type SqlEffect =
  | { kind: "removal"; table: string; column?: string }
  | { kind: "rebuild"; table: string; keptColumns: Set<string> };

// SQLite reads a single-quoted name as an identifier where one is expected, so
// all four quote styles count.
const NAME = String.raw`[\`"'\[]?([A-Za-z_][\w$]*)[\`"'\]]?`;
// SQLite accepts a schema qualifier such as `main.` before a table name.
const TABLE = String.raw`(?:[\`"'\[]?[A-Za-z_][\w$]*[\`"'\]]?\s*\.\s*)?${NAME}`;
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
  const code = stripComments(sql);
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
  const columnRemovals = [...code.matchAll(DROP_COLUMN), ...code.matchAll(RENAME_COLUMN)].map(
    (m) => ({ table: lower(m[1]), column: lower(m[2]), at: m.index }),
  );
  const copies = [...code.matchAll(COPY_ROWS)].map((m) => ({
    into: lower(m[1]),
    columns: new Set(
      m[2]
        .split(",")
        .map((column) => lower(column.trim().replace(/^[`"'[]|[`"'\]]$/g, "")))
        .filter(Boolean),
    ),
    from: lower(m[3]),
    at: m.index,
  }));
  const nearestAfter = <T extends { at: number }>(items: T[], at: number) =>
    items.filter((item) => item.at > at).sort((a, b) => a.at - b.at)[0];
  const nearestBefore = <T extends { at: number }>(items: T[], at: number) =>
    items.filter((item) => item.at < at).sort((a, b) => b.at - a.at)[0];

  // A SQLite table rebuild removes a table under its name, then gives the name
  // back to a copy of its rows. drizzle-kit fills `__new_t` from `t`, drops `t`
  // and renames the copy onto it. A hand-written rebuild may instead rename `t`
  // away, create `t` again and fill it from the old one. The rebuilt table keeps
  // the columns its copy statement names, less any the copy loses before it
  // takes the name. Changes after that are made to `t` and scanned as such.
  const effects: SqlEffect[] = [];
  for (const drop of drops) {
    const restore = nearestAfter(
      renames.filter((rename) => rename.to === drop.table),
      drop.at,
    );
    const copy =
      restore &&
      nearestBefore(
        copies.filter((c) => c.into === restore.from && c.from === drop.table),
        drop.at,
      );
    if (!restore || !copy) {
      effects.push({ kind: "removal", table: drop.table });
      continue;
    }
    const lost = columnRemovals.filter(
      (removal) =>
        removal.table === restore.from && removal.at > copy.at && removal.at < restore.at,
    );
    const keptColumns = new Set(copy.columns);
    for (const removal of lost) keptColumns.delete(removal.column);
    effects.push({ kind: "rebuild", table: drop.table, keptColumns });
  }
  for (const rename of renames) {
    const recreate = nearestAfter(
      creates.filter((create) => create.table === rename.from),
      rename.at,
    );
    const copy =
      recreate &&
      nearestAfter(
        copies.filter((c) => c.into === rename.from && c.from === rename.to),
        recreate.at,
      );
    effects.push(
      copy
        ? { kind: "rebuild", table: rename.from, keptColumns: copy.columns }
        : { kind: "removal", table: rename.from },
    );
  }
  for (const removal of columnRemovals) {
    effects.push({ kind: "removal", table: removal.table, column: removal.column });
  }
  return effects;
}

/**
 * Blanks comments and keeps everything else as written. A `--` or `/*` inside
 * a quoted string or identifier is not a comment. A keyword inside a string
 * still matches, which can only make the check stricter.
 */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      out += " ";
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          // A doubled quote escapes itself. Brackets have no escape.
          if (close !== "]" && sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
