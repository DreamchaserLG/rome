/**
 * What a Dream or skill-review run wrote, read off its agent's file-tool calls.
 *
 * Both agents produce their output by writing files: the dream agent edits
 * memory files and writes a journal entry, the skill-review agent writes or
 * edits a `SKILL.md`. Recording those calls is what lets the UI show what came
 * out of a run without diffing the filesystem afterwards.
 */

export type ChangeOp = "write" | "edit";

export interface FileChange {
  op: ChangeOp;
  path: string;
  /** The full file for a write, the replacement text for an edit. */
  content: string;
  /** The text an edit replaced. Null for a write. */
  previous: string | null;
  truncated: boolean;
}

/** Caps one stored change, so a full-file rewrite of a large memory file
 *  cannot bloat the run table. */
export const MAX_CHANGE_CHARS = 20_000;

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CHANGE_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_CHANGE_CHARS), truncated: true };
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The file changes one tool call makes. Covers Claude's `Write`, `Edit`, and
 * `MultiEdit`, and Codex `fileChange` items, which the Codex provider reports
 * as `Edit` with the raw item as input. Any other tool returns nothing.
 */
export function changesFromToolUse(tool: string, input: unknown): FileChange[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  if (record.type === "fileChange" && Array.isArray(record.changes)) {
    return codexFileChanges(record.changes);
  }
  const path = str(record.file_path);
  if (!path) return [];

  const edit = (oldText: unknown, newText: unknown): FileChange | null => {
    const next = str(newText);
    if (next === null) return null;
    const content = clip(next);
    const previous = clip(str(oldText) ?? "");
    return {
      op: "edit",
      path,
      content: content.text,
      previous: previous.text,
      truncated: content.truncated || previous.truncated,
    };
  };

  switch (tool) {
    case "Write": {
      const text = str(record.content);
      if (text === null) return [];
      const content = clip(text);
      return [
        { op: "write", path, content: content.text, previous: null, truncated: content.truncated },
      ];
    }
    case "Edit": {
      const change = edit(record.old_string, record.new_string);
      return change ? [change] : [];
    }
    case "MultiEdit": {
      if (!Array.isArray(record.edits)) return [];
      return record.edits.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const { old_string, new_string } = item as Record<string, unknown>;
        const change = edit(old_string, new_string);
        return change ? [change] : [];
      });
    }
    default:
      return [];
  }
}

/**
 * Reads a Codex `fileChange` item's `changes[]`. An add's `diff` is the new
 * file and a delete's is the old one; an update's is a unified diff, split
 * back into before and after text so it renders like a Claude `Edit`.
 */
function codexFileChanges(changes: unknown[]): FileChange[] {
  return changes.flatMap((entry): FileChange[] => {
    if (!entry || typeof entry !== "object") return [];
    const { path, kind, diff } = entry as Record<string, unknown>;
    if (typeof path !== "string" || typeof diff !== "string") return [];
    if (!kind || typeof kind !== "object") return [];
    const { type, move_path } = kind as Record<string, unknown>;

    switch (type) {
      case "add": {
        const content = clip(diff);
        return [
          {
            op: "write",
            path,
            content: content.text,
            previous: null,
            truncated: content.truncated,
          },
        ];
      }
      case "update": {
        const sides = splitUnifiedDiff(diff);
        const content = clip(sides.content);
        const previous = clip(sides.previous);
        return [
          {
            op: "edit",
            path: str(move_path) ?? path,
            content: content.text,
            previous: previous.text,
            truncated: content.truncated || previous.truncated,
          },
        ];
      }
      case "delete": {
        const previous = clip(diff);
        return [
          { op: "edit", path, content: "", previous: previous.text, truncated: previous.truncated },
        ];
      }
      default:
        return [];
    }
  });
}

/**
 * Splits a unified diff into the text it removed and the text it left, with a
 * blank line between hunks. Lines are sorted by their first character only,
 * because a removed `---` frontmatter line arrives as `----`. Anything before
 * the first `@@`, and any line without a ` `, `-` or `+` prefix, is skipped:
 * file headers, `\ No newline at end of file`, and the `Moved to:` trailer
 * Codex appends to a moved file's diff.
 */
function splitUnifiedDiff(diff: string): { previous: string; content: string } {
  const previous: string[] = [];
  const content: string[] = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      if (previous.length > 0) previous.push("");
      if (content.length > 0) content.push("");
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const text = line.slice(1);
    if (line.startsWith(" ")) {
      previous.push(text);
      content.push(text);
    } else if (line.startsWith("-")) {
      previous.push(text);
    } else if (line.startsWith("+")) {
      content.push(text);
    }
  }
  return { previous: previous.join("\n"), content: content.join("\n") };
}

type FileArea = "journal" | "memory" | "skill" | "other";

export interface ClassifiedPath {
  area: FileArea;
  /** Short path for display. */
  label: string;
  /** Path relative to the memory directory, the form the Memory page routes on. */
  memoryFile: string | null;
  skillName: string | null;
  /** App the skill belongs to, when the path names one. */
  skillAppId: string | null;
}

const MEMORY_RE = /^(?:.*?\/)?memory\/(.+)$/;
const JOURNAL_RE = /^journal\/\d{4}\/\d{2}\/\d{2}\.md$/;
const SKILL_RE = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i;
/** Where a skill's app lives: the repo seed, an installed artifact, or a
 *  custom app's source under the profile's projects. First match wins. */
const APP_RES = [
  /(?:^|\/)rome_apps\/([^/]+)\//,
  /(?:^|\/)apps\/installed\/([^/]+)\//,
  /(?:^|\/)projects\/apps\/([^/]+)\//,
];

export function classifyPath(path: string): ClassifiedPath {
  const skill = SKILL_RE.exec(path);
  if (skill) {
    const app = APP_RES.map((re) => re.exec(path)).find(Boolean);
    return {
      area: "skill",
      label: shortPath(path),
      memoryFile: null,
      skillName: skill[1] ?? null,
      skillAppId: app?.[1] ?? null,
    };
  }

  const memory = MEMORY_RE.exec(path);
  if (memory?.[1]) {
    const memoryFile = memory[1];
    return {
      area: JOURNAL_RE.test(memoryFile) ? "journal" : "memory",
      label: memoryFile,
      memoryFile,
      skillName: null,
      skillAppId: null,
    };
  }

  return {
    area: "other",
    label: shortPath(path),
    memoryFile: null,
    skillName: null,
    skillAppId: null,
  };
}

/** Drops the machine-specific prefix: everything up to `rome_apps/`, or all
 *  but the last three segments. */
function shortPath(path: string): string {
  const appsAt = path.indexOf("rome_apps/");
  if (appsAt >= 0) return path.slice(appsAt + "rome_apps/".length);
  const segments = path.split("/").filter(Boolean);
  return segments.length > 3 ? segments.slice(-3).join("/") : segments.join("/");
}

export interface ChangedFile extends ClassifiedPath {
  path: string;
  changes: Array<Omit<FileChange, "path">>;
}

/** Groups changes by file, in the order each file was first touched. */
export function groupByFile(changes: FileChange[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const { path, ...change } of changes) {
    let file = files.get(path);
    if (!file) {
      file = { path, ...classifyPath(path), changes: [] };
      files.set(path, file);
    }
    file.changes.push(change);
  }
  return [...files.values()];
}
