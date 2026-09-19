/**
 * Pi's compaction entry carries the files the summarised messages touched, and
 * the next compaction reads them back, so a compaction entry written by this
 * plugin has to carry them in the same shape pi's own does.
 */
export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

function values(paths: Iterable<string> | undefined): string[] {
  return paths ? [...paths] : [];
}

/** Files only read, and files changed; a changed file counts as changed only. */
export function fileLists(operations: FileOperations | undefined): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([
    ...values(operations?.written),
    ...values(operations?.edited),
  ]);
  return {
    readFiles: values(operations?.read).filter((path) => !modified.has(path)),
    modifiedFiles: [...modified],
  };
}
