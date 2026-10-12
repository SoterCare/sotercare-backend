/** Raw `query()` results: postgres returns rows, or [rows, count] for UPDATE. */
export const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) && Array.isArray(result[0])
    ? result[0]
    : result) as T[];
