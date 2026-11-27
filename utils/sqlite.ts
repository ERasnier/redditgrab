import initSqlJs, { type SqlJsStatic } from "sql.js";

let sqlPromise: Promise<SqlJsStatic> | null = null;
let sqlUsers = 0;

/**
 * Borrow the SQLite engine (sql.js) for one job, and let it go afterwards.
 *
 * A WebAssembly heap grows to fit the biggest database it has held and never
 * shrinks, so a cached engine kept the page at the size of the largest file
 * for the rest of the session. Loading it per job costs a fraction of a
 * second; dropping it lets the whole heap be collected.
 */
export const withSql = async <T>(job: (SQL: SqlJsStatic) => Promise<T> | T): Promise<T> => {
  sqlUsers += 1;
  try {
    sqlPromise ??= initSqlJs({
      locateFile: () => browser.runtime.getURL("/sqljs/sql-wasm.wasm"),
    });
    return await job(await sqlPromise);
  } finally {
    sqlUsers -= 1;
    if (sqlUsers === 0) sqlPromise = null;
  }
};
