import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManifestStore } from "../src/server/manifestStore";
import { DurableTestFileStore, syntheticPut } from "./fixtures/durableFileStore";

let root: string;
let worker: string;
let child: ChildProcess | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "websync-kill-recovery-"));
  worker = join(root, "worker.cjs");
  await build({ entryPoints: [join(process.cwd(), "tests/fixtures/durableStoreWorker.ts")], outfile: worker,
    platform: "node", bundle: true, format: "cjs", target: "node20", logLevel: "silent" });
});

afterAll(async () => {
  child?.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
});

describe("durable recovery after abrupt process termination", () => {
  it.each(["before-cloud-manifest", "after-cloud-manifest", "after-local-manifest"])(
    "keeps a recoverable version after %s", async (failpoint) => {
      const scenarioDir = join(root, failpoint);
      const cloud = new DurableTestFileStore(join(scenarioDir, "remote"));
      const options = { dataDir: join(scenarioDir, "local"), vaultId: "test-vault", fileStore: cloud };
      const store = await ManifestStore.open(options);
      const original = await store.applyPut(syntheticPut("base", "base synthetic note", 0));
      expect(original.kind).toBe("accepted");

      child = spawn(process.execPath, [worker, scenarioDir, failpoint], { stdio: ["ignore", "pipe", "pipe"] });
      const processToKill = child;
      let stderr = "";
      processToKill.stderr!.on("data", (data) => { stderr += String(data); });
      const exit = new Promise<void>((resolve) => processToKill.once("exit", () => resolve()));
      await new Promise<void>((resolve, reject) => {
        let stdout = "";
        let ready = false;
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${failpoint}: ${stderr}`)), 5_000);
        processToKill.stdout!.on("data", (data) => {
          stdout += String(data);
          if (!ready && stdout.includes("FAILPOINT_READY\n")) { ready = true; clearTimeout(timer); resolve(); }
        });
        processToKill.once("error", (error) => { clearTimeout(timer); reject(error); });
        processToKill.once("exit", (code) => { if (!ready) { clearTimeout(timer); reject(new Error(`Worker exited ${code}: ${stderr}`)); } });
      });
      processToKill.kill("SIGKILL");
      await exit;
      child = undefined;

      const reopened = await ManifestStore.open(options);
      const committed = failpoint !== "before-cloud-manifest";
      const expectedText = committed ? "updated synthetic note" : "base synthetic note";
      expect((await reopened.readEntryContent(reopened.snapshot().files["test-note.md"]))?.toString()).toBe(expectedText);
      expect(reopened.snapshot().revision).toBe(committed ? 2 : 1);
      const retry = await reopened.applyPut(syntheticPut("update", "updated synthetic note", 1));
      expect(retry).toMatchObject({ kind: "accepted", ...(committed ? { replayed: true } : {}) });
      expect(reopened.snapshot().revision).toBe(2);
      expect((await reopened.readEntryContent(reopened.snapshot().files["test-note.md"]))?.toString()).toBe("updated synthetic note");
      expect((await reopened.readOperationLog()).map((operation) => operation.revision)).toEqual([1, 2]);
    }, 12_000
  );
});
