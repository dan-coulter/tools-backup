// A fetcher knows how to get one registered item onto local disk so it can be
// uploaded. Everything here today reads from this server, but a fetcher can
// pull from anywhere (ssh, an HTTP export endpoint, a docker exec...), as long
// as it leaves a file in `workDir`.

export type Snapshot = {
  // A file inside workDir, owned by the backup run (deleted afterwards).
  file: string;
  // Name to use in S3, e.g. "watched.db".
  filename: string;
  // When the source last changed, if known.
  sourceMtime?: Date;
  // Gzip before upload. Off for files that are already compressed.
  compress: boolean;
};

export type FetcherOption = { name: string; label: string; placeholder?: string };

export type Fetcher = {
  id: string;
  label: string;
  description: string;
  // What `path` means for this fetcher, shown in the UI.
  pathHint: string;
  options?: FetcherOption[];
  // Cheap check used when adding an item and when rendering the dashboard.
  inspect(path: string, options: Record<string, string>): Promise<{ ok: boolean; detail: string; mtime?: Date; bytes?: number }>;
  snapshot(path: string, options: Record<string, string>, workDir: string): Promise<Snapshot>;
  // Optional sanity check on a restored copy (used by verify).
  check?(file: string): Promise<string>;
};
