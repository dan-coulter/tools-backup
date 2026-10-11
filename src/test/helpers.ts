import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A temp folder for one test, removed by `cleanup()`. */
export function tempDir(prefix = "tools-backup-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(...dirs: string[]) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

/** Writes `content` to `dir/name` and sets its mtime, so "newest" is predictable. */
export function writeFile(dir: string, name: string, content: string | Buffer, mtime?: Date): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

/**
 * Points DOCKER_BIN at a stand-in that drops "exec <container>" and runs the
 * rest on this machine, so "app:/some/dir" means the local /some/dir.
 */
export function fakeDocker(dir: string): string {
  const bin = path.join(dir, "docker");
  fs.writeFileSync(bin, '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 });
  process.env.DOCKER_BIN = bin;
  return bin;
}

/**
 * Loads the modules that use the database against a new, empty database
 * file. db.ts keeps one open connection per module instance, so each call
 * resets Jest's module registry (mocks stay registered).
 */
export function freshDb(dir: string) {
  process.env.DATABASE_PATH = path.join(dir, "tools-backup.db");
  jest.resetModules();
  return {
    db: require("@/lib/db") as typeof import("@/lib/db"),
    backup: require("@/lib/backup") as typeof import("@/lib/backup"),
    items: require("@/lib/items") as typeof import("@/lib/items"),
    s3: require("@/lib/s3") as typeof import("@/lib/s3"),
  };
}
