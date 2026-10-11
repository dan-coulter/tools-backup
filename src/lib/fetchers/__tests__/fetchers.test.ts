import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cleanup, fakeDocker, tempDir, writeFile } from "@/test/helpers";
import { detectFetcher, FETCHERS, getFetcher } from "..";
import { dockerDirFetcher, isContainerPath, parseContainerPath, parseExcludes } from "../docker-dir";
import { fileFetcher } from "../file";
import { latestInDirFetcher } from "../latest-in-dir";
import { sqliteFetcher } from "../sqlite";

let src: string;
let work: string;
beforeEach(() => {
  src = tempDir();
  work = tempDir();
});
afterEach(() => cleanup(src, work));

/** A database left in WAL mode with rows not yet checkpointed into the main file. */
function walDatabase(file: string) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec("CREATE TABLE movies (title TEXT)");
  db.prepare("INSERT INTO movies VALUES (?)").run("Sinbad the Sailor");
  return db; // left open, so the WAL isn't folded back in
}

describe("getFetcher", () => {
  it("finds each registered fetcher by id", () => {
    for (const f of FETCHERS) expect(getFetcher(f.id)).toBe(f);
  });

  it("names the known fetchers when the id is wrong", () => {
    expect(() => getFetcher("ssh")).toThrow('Unknown fetcher "ssh". Known: sqlite, file, latest-in-dir, docker-dir');
  });
});

describe("detectFetcher", () => {
  it("uses docker-dir for container:/path, without touching the disk", async () => {
    expect(await detectFetcher("jenkins:/var/jenkins_home")).toBe("docker-dir");
  });

  it("uses latest-in-dir for folders", async () => {
    expect(await detectFetcher(src)).toBe("latest-in-dir");
  });

  it("uses sqlite for files with the SQLite header", async () => {
    const file = path.join(src, "app.db");
    new Database(file).exec("CREATE TABLE t (x)");
    expect(await detectFetcher(file)).toBe("sqlite");
  });

  it("uses file for everything else, including short files", async () => {
    expect(await detectFetcher(writeFile(src, ".env", "A=1\n"))).toBe("file");
    expect(await detectFetcher(writeFile(src, "empty", ""))).toBe("file");
  });
});

describe("file fetcher", () => {
  it("accepts a readable file and reports its size", async () => {
    const file = writeFile(src, "config.json", "{}");
    expect(await fileFetcher.inspect(file, {})).toMatchObject({ ok: true, detail: "readable file", bytes: 2 });
  });

  it("rejects folders and missing paths", async () => {
    expect(await fileFetcher.inspect(src, {})).toEqual({ ok: false, detail: "not a regular file" });
    expect((await fileFetcher.inspect(path.join(src, "nope"), {})).ok).toBe(false);
  });

  it("copies the file and renames dotfiles so they show in S3", async () => {
    const mtime = new Date("2026-10-01T12:00:00Z");
    const file = writeFile(src, ".env", "SECRET=1\n", mtime);
    const snap = await fileFetcher.snapshot(file, {}, work);
    expect(snap).toEqual({ file: path.join(work, "dot.env"), filename: "dot.env", sourceMtime: mtime, compress: true });
    expect(fs.readFileSync(snap.file, "utf8")).toBe("SECRET=1\n");
  });

  it("doesn't gzip files that are already compressed", async () => {
    for (const name of ["backup.zip", "dump.sql.gz", "x.TGZ", "a.7z"]) {
      const snap = await fileFetcher.snapshot(writeFile(src, name, "x"), {}, work);
      expect(snap.compress).toBe(false);
    }
  });
});

describe("latest-in-dir fetcher", () => {
  it("picks the newest matching file", async () => {
    writeFile(src, "sonarr_backup_1.zip", "old", new Date("2026-10-01"));
    writeFile(src, "sonarr_backup_2.zip", "new", new Date("2026-10-03"));
    writeFile(src, "notes.txt", "newest but not a match", new Date("2026-10-05"));
    const snap = await latestInDirFetcher.snapshot(src, { pattern: "sonarr_backup_*.zip" }, work);
    expect(snap.filename).toBe("sonarr_backup_2.zip");
    expect(fs.readFileSync(snap.file, "utf8")).toBe("new");
    expect(snap.compress).toBe(false);
  });

  it("matches everything without a pattern, and gzips uncompressed files", async () => {
    writeFile(src, "a.txt", "a", new Date("2026-10-01"));
    writeFile(src, "b.json", "b", new Date("2026-10-02"));
    const snap = await latestInDirFetcher.snapshot(src, {}, work);
    expect(snap).toMatchObject({ filename: "b.json", compress: true });
  });

  it("treats dots in the pattern literally and ? as one character", async () => {
    writeFile(src, "backupXzip", "x", new Date("2026-10-02"));
    writeFile(src, "backup.zip", "y", new Date("2026-10-01"));
    expect((await latestInDirFetcher.snapshot(src, { pattern: "backup.zip" }, work)).filename).toBe("backup.zip");
    expect((await latestInDirFetcher.snapshot(src, { pattern: "backup?zip" }, work)).filename).toBe("backupXzip");
  });

  it("ignores subfolders", async () => {
    fs.mkdirSync(path.join(src, "newer.zip"));
    writeFile(src, "real.zip", "z", new Date("2000-01-01"));
    expect((await latestInDirFetcher.snapshot(src, { pattern: "*.zip" }, work)).filename).toBe("real.zip");
  });

  it("says when nothing matches", async () => {
    writeFile(src, "a.txt", "a");
    expect(await latestInDirFetcher.inspect(src, { pattern: "*.zip" })).toEqual({
      ok: false,
      detail: "no files matching *.zip",
    });
    await expect(latestInDirFetcher.snapshot(src, { pattern: "*.zip" }, work)).rejects.toThrow(
      `No files matching *.zip in ${src}`,
    );
  });

  it("names the newest file when inspecting", async () => {
    writeFile(src, "a.zip", "a", new Date("2026-10-01"));
    expect(await latestInDirFetcher.inspect(src, { pattern: "*.zip" })).toMatchObject({ ok: true, detail: "newest: a.zip" });
  });
});

describe("docker-dir fetcher", () => {
  let bin: string;
  beforeEach(() => {
    bin = tempDir();
    fakeDocker(bin);
  });
  afterEach(() => {
    delete process.env.DOCKER_BIN;
    cleanup(bin);
  });

  it("parses container paths and exclude lists", () => {
    expect(parseContainerPath("jenkins:/var/jenkins_home")).toEqual({
      container: "jenkins",
      dir: "/var/jenkins_home",
    });
    expect(isContainerPath("/home/dan/.env")).toBe(false);
    expect(isContainerPath("jenkins:relative")).toBe(false);
    expect(() => parseContainerPath("/var/jenkins_home")).toThrow("Expected <container>:/path");
    expect(parseExcludes("plugins, war\njobs/*/builds ,")).toEqual(["plugins", "war", "jobs/*/builds"]);
    expect(parseExcludes(undefined)).toEqual([]);
  });

  it("tars the folder, leaving out excluded paths", async () => {
    writeFile(src, "config.xml", "<hudson/>");
    writeFile(src, "jobs/deploy/config.xml", "<project/>");
    writeFile(src, "jobs/deploy/builds/1/log", "build output");
    writeFile(src, "plugins/git.jpi", "zip");
    writeFile(src, "secrets/master.key", "key");
    const snap = await dockerDirFetcher.snapshot(
      `jenkins:${src}`,
      { exclude: "plugins, secrets, jobs/*/builds" },
      work,
    );
    expect(snap).toEqual({
      file: path.join(work, `${path.basename(src)}.tar`),
      filename: `${path.basename(src)}.tar`,
      compress: true,
    });
    expect(await dockerDirFetcher.check!(snap.file)).toBe("readable tar, 2 files");
    const out = tempDir();
    try {
      execFileSync("tar", ["-xf", snap.file, "-C", out]);
      expect(fs.readFileSync(path.join(out, "jobs/deploy/config.xml"), "utf8")).toBe("<project/>");
      expect(fs.existsSync(path.join(out, "jobs/deploy/builds"))).toBe(false);
      expect(fs.existsSync(path.join(out, "plugins"))).toBe(false);
      expect(fs.existsSync(path.join(out, "secrets"))).toBe(false);
    } finally {
      cleanup(out);
    }
  });

  it("checks the folder exists in the container", async () => {
    expect(await dockerDirFetcher.inspect(`jenkins:${src}`, {})).toEqual({
      ok: true,
      detail: "folder in container jenkins",
    });
    expect(await dockerDirFetcher.inspect(`jenkins:${src}/nope`, {})).toEqual({
      ok: false,
      detail: `${src}/nope is not a folder in jenkins`,
    });
  });

  it("fails when tar fails, and when docker can't be run", async () => {
    await expect(dockerDirFetcher.snapshot(`jenkins:${src}/nope`, {}, work)).rejects.toThrow(
      "tar in jenkins failed (exit 2)",
    );
    process.env.DOCKER_BIN = path.join(bin, "missing");
    expect((await dockerDirFetcher.inspect(`jenkins:${src}`, {})).detail).toMatch(/ENOENT/);
  });

  it("fails when docker is killed by a signal, even mid-archive", async () => {
    const killed = path.join(bin, "killed-docker");
    fs.writeFileSync(killed, "#!/bin/sh\nkill -KILL $$\n", { mode: 0o755 });
    process.env.DOCKER_BIN = killed;
    await expect(dockerDirFetcher.snapshot(`jenkins:${src}`, {}, work)).rejects.toThrow(
      "killed-docker was killed by SIGKILL",
    );
  });

  it("rejects, rather than crashing, when the archive can't be written", async () => {
    writeFile(src, "config.xml", "<hudson/>");
    await expect(dockerDirFetcher.snapshot(`jenkins:${src}`, {}, path.join(work, "missing"))).rejects.toThrow("ENOENT");
  });

  it("fails the check on a file that isn't a tar", async () => {
    await expect(dockerDirFetcher.check!(writeFile(src, "junk.tar", "x".repeat(4096)))).rejects.toThrow();
  });
});

describe("sqlite fetcher", () => {
  it("accepts a database and rejects other files", async () => {
    const file = path.join(src, "app.db");
    new Database(file).exec("CREATE TABLE t (x)");
    expect(await sqliteFetcher.inspect(file, {})).toMatchObject({ ok: true, detail: "readable SQLite database" });
    expect((await sqliteFetcher.inspect(writeFile(src, "not.db", "hello, this is text"), {})).ok).toBe(false);
  });

  it("snapshots a live WAL database into one self-contained file", async () => {
    const file = path.join(src, "watched.db");
    const live = walDatabase(file);
    try {
      const snap = await sqliteFetcher.snapshot(file, {}, work);
      expect(snap).toMatchObject({ filename: "watched.db", compress: true });
      expect(fs.existsSync(`${snap.file}-wal`)).toBe(false);
      const copy = new Database(snap.file, { readonly: true });
      try {
        expect(copy.pragma("journal_mode", { simple: true })).toBe("delete");
        // The row only lived in the WAL, so this proves it was captured.
        expect(copy.prepare("SELECT title FROM movies").pluck().all()).toEqual(["Sinbad the Sailor"]);
      } finally {
        copy.close();
      }
    } finally {
      live.close();
    }
  });

  it("checks a restored copy's integrity and counts its tables", async () => {
    const file = path.join(src, "app.db");
    new Database(file).exec("CREATE TABLE a (x); CREATE TABLE b (y);");
    expect(await sqliteFetcher.check!(file)).toBe("integrity_check ok, 2 tables");
  });

  it("fails the check on a file that isn't a database", async () => {
    const junk = writeFile(src, "junk.db", "x".repeat(4096));
    const outcome = await sqliteFetcher.check!(junk).then(
      (v) => `resolved: ${v}`,
      (e: Error) => `threw: ${e.message}`,
    );
    expect(outcome).toBe("threw: file is not a database");
  });
});
