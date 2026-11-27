import { withSql } from "./sqlite";

/**
 * Reading Reddit post links out of a file for a large job: a SQLite database
 * (any schema — the column holding the links is found, or picked), or a text
 * file with links anywhere in it.
 *
 * Everything is reduced to Reddit post ids (t3_…), which is what the download
 * history keys on, so "already downloaded" is a straight set lookup.
 */

/** Post ids in links: /comments/<id>, t3_<id>, and redd.it/<id> short links. */
const LINK_ID =
  /(?:\/comments\/|\bt3_|(?:^|[^.\w])redd\.it\/)([a-z0-9]{4,10})(?![a-z0-9])/gi;
/** A bare post id, as an archive's id column holds them. */
const BARE_ID = /^(?:t3_)?([a-z0-9]{4,10})$/i;
/** Column names that hold bare ids rather than links. */
const ID_COLUMN = /^(?:post_?)?id$|^name$|^fullname$|^thing_?id$/i;

/** Post ids found in one value. */
export const idsInValue = (value: string, bare: boolean): string[] => {
  if (bare) {
    const match = value.trim().match(BARE_ID);
    return match ? [`t3_${match[1].toLowerCase()}`] : [];
  }
  const ids: string[] = [];
  for (const match of value.matchAll(LINK_ID)) ids.push(`t3_${match[1].toLowerCase()}`);
  return ids;
};

/** Files bigger than this can't be opened by the in-browser SQLite engine. */
export const MAX_SQLITE_BYTES = 1024 ** 3;

export type LinkColumn = {
  table: string;
  column: string;
  rows: number;
  /** How the column holds posts: as links, or as bare ids. */
  kind: "links" | "ids";
  /** Of the rows sampled, how many held a post. */
  hits: number;
  sampled: number;
  example?: string;
};

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Every column in the database that holds Reddit posts, best first. Looks at
 * up to 500 rows of each text column.
 */
export const findLinkColumns = (bytes: Uint8Array): Promise<LinkColumn[]> =>
  withSql((SQL) => {
    let db;
    try {
      db = new SQL.Database(bytes);
    } catch {
      throw new Error("the file isn't a SQLite database");
    }
    try {
      const found: LinkColumn[] = [];
      const tables = db.exec(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
      )[0]?.values.map((row) => String(row[0])) ?? [];
      for (const table of tables) {
        const columns =
          db.exec(`PRAGMA table_info(${quote(table)})`)[0]?.values.map((row) => String(row[1])) ?? [];
        const rows = Number(db.exec(`SELECT COUNT(*) FROM ${quote(table)}`)[0]?.values[0]?.[0] ?? 0);
        for (const column of columns) {
          const sample = db.exec(
            `SELECT ${quote(column)} FROM ${quote(table)} WHERE typeof(${quote(column)}) = 'text' LIMIT 500`,
          )[0]?.values.map((row) => String(row[0])) ?? [];
          if (sample.length === 0) continue;
          const linkHits = sample.filter((v) => idsInValue(v, false).length > 0);
          const bareHits = ID_COLUMN.test(column)
            ? sample.filter((v) => idsInValue(v, true).length > 0)
            : [];
          // Bare ids only count when nearly the whole column looks like them;
          // short words would otherwise pass for ids.
          const useBare = bareHits.length > linkHits.length && bareHits.length >= sample.length * 0.9;
          const hits = useBare ? bareHits : linkHits;
          if (hits.length === 0) continue;
          found.push({
            table,
            column,
            rows,
            kind: useBare ? "ids" : "links",
            hits: hits.length,
            sampled: sample.length,
            example: hits[0]?.slice(0, 120),
          });
        }
      }
      return found.sort(
        (a, b) => b.hits / b.sampled - a.hits / a.sampled || b.rows - a.rows,
      );
    } finally {
      db.close();
    }
  });

/** Every post id in one column, de-duplicated, in table order. */
export const readPostIdsFromColumn = (
  bytes: Uint8Array,
  { table, column, kind }: Pick<LinkColumn, "table" | "column" | "kind">,
): Promise<string[]> =>
  withSql((SQL) => {
    const db = new SQL.Database(bytes);
    try {
      const ids = new Set<string>();
      const rows = db.prepare(
        `SELECT ${quote(column)} FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL`,
      );
      while (rows.step()) {
        for (const id of idsInValue(String(rows.get()[0]), kind === "ids")) ids.add(id);
      }
      rows.free();
      return [...ids];
    } finally {
      db.close();
    }
  });

/**
 * Every post id in a text file, read line by line so a file of millions of
 * links doesn't have to fit in memory as one string.
 */
export const readPostIdsFromText = async (file: Blob): Promise<string[]> => {
  const ids = new Set<string>();
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let carry = "";
  for (;;) {
    const { value, done } = await reader.read();
    const text = carry + (value ?? "");
    const lines = text.split(/\r?\n/);
    carry = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      // A line that is only an id (a plain id list) counts as one too.
      // Only lines holding a digit, so a stray word isn't taken for an id.
      const found = idsInValue(line, false);
      const list = found.length ? found : /\d/.test(line) ? idsInValue(line, true) : [];
      for (const id of list) ids.add(id);
    }
    if (done) break;
  }
  return [...ids];
};

/** True if the file starts with SQLite's header. */
export const isSqliteFile = async (file: Blob) =>
  new TextDecoder().decode(new Uint8Array(await file.slice(0, 16).arrayBuffer())).startsWith(
    "SQLite format 3",
  );
