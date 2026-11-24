/**
 * The newest record per key, by its `at` time: how deletions and synced keys merge, where the
 * latest change wins whichever device made it. Free of `node:` imports.
 */
export function newestBy<T extends { at: string }>(
  records: Iterable<T>,
  key: (record: T) => string,
): Map<string, T> {
  const newest = new Map<string, T>();
  for (const record of records) {
    const seen = newest.get(key(record));
    if (!seen || record.at > seen.at) newest.set(key(record), record);
  }
  return newest;
}
