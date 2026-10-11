import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Fetcher } from "./types";

// A folder inside a running Docker container, archived with the container's
// own tar. For apps that keep their state as many small files owned by root,
// like Jenkins' /var/jenkins_home. `docker exec` runs as the container's user,
// so it can read what `dan` can't on the host.
//
// Paths look like "<container>:/abs/dir". Tests point DOCKER_BIN at a stand-in.

const CONTAINER_PATH = /^([a-zA-Z0-9][a-zA-Z0-9_.-]*):(\/.*)$/;

export function isContainerPath(p: string) {
  return CONTAINER_PATH.test(p);
}

export function parseContainerPath(p: string) {
  const m = CONTAINER_PATH.exec(p);
  if (!m) throw new Error(`Expected <container>:/path, got "${p}"`);
  return { container: m[1], dir: m[2] };
}

// "plugins, war jobs/*/builds" -> ["plugins", "war", "jobs/*/builds"]
export function parseExcludes(s: string | undefined) {
  return (s ?? "").split(/[\s,]+/).filter(Boolean);
}

const docker = () => process.env.DOCKER_BIN || "docker";

// Runs a command, collecting stdout as text or streaming it into `stdout`.
function run(
  cmd: string,
  args: string[],
  stdout?: fs.WriteStream,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    if (stdout) {
      // A failed write (e.g. disk full) fails this item instead of crashing the run.
      stdout.on("error", (e) => {
        child.kill();
        reject(e);
      });
      child.stdout.pipe(stdout);
    } else child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      // Killed (e.g. OOM): the output may be cut short, so never treat it as an exit code.
      if (code === null) return reject(new Error(`${path.basename(cmd)} was killed by ${signal}`));
      const done = () => resolve({ code, stdout: out, stderr: err.trim() });
      if (stdout && !stdout.writableFinished) stdout.on("finish", done);
      else done();
    });
  });
}

export const dockerDirFetcher: Fetcher = {
  id: "docker-dir",
  label: "Folder in a Docker container",
  description: "Tars a folder inside a running container with docker exec, skipping the excluded paths.",
  pathHint: "jenkins:/var/jenkins_home",
  options: [
    {
      name: "exclude",
      label: "Exclude (tar patterns)",
      placeholder: "plugins, war, jobs/*/builds",
    },
  ],
  async inspect(p) {
    try {
      const { container, dir } = parseContainerPath(p);
      const r = await run(docker(), ["exec", container, "test", "-d", dir]);
      if (r.code !== 0)
        return {
          ok: false,
          detail: r.stderr || `${dir} is not a folder in ${container}`,
        };
      return { ok: true, detail: `folder in container ${container}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  },
  async snapshot(p, options, workDir) {
    const { container, dir } = parseContainerPath(p);
    const filename = `${path.basename(dir) || container}.tar`;
    const file = path.join(workDir, filename);
    const excludes = parseExcludes(options.exclude).map((x) => `--exclude=${x}`);
    const r = await run(
      docker(),
      ["exec", container, "tar", "-cf", "-", "-C", dir, ...excludes, "."],
      fs.createWriteStream(file),
    );
    // GNU tar exits 1 when a file changed while it was read (Jenkins rewrites
    // queue.xml and friends). The archive is still complete; 2+ is a real error.
    if (r.code > 1) throw new Error(`tar in ${container} failed (exit ${r.code}): ${r.stderr}`);
    return { file, filename, compress: true };
  },
  async check(file) {
    const r = await run("tar", ["-tf", file]);
    if (r.code !== 0) throw new Error(r.stderr || `tar -tf exited ${r.code}`);
    const entries = r.stdout.split("\n").filter((l) => l && !l.endsWith("/")).length;
    return `readable tar, ${entries} files`;
  },
};
