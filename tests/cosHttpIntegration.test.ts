import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import COS from "cos-nodejs-sdk-v5";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CosFileStore } from "../src/server/cosStore";
import { ManifestStore } from "../src/server/manifestStore";

// Exercise the real COS SDK over HTTP against a local synthetic endpoint.
// This is not a substitute for testing an actual Tencent COS bucket.
const objects = new Map<string, { body: Buffer; encoding?: string }>();
const parts = new Map<number, Buffer>();
let server: Server;
let store: CosFileStore;
let abortCount = 0;
let failPart = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const url = new URL(req.url!, "http://127.0.0.1");
      const key = decodeURIComponent(url.pathname.slice(1));
      const body = Buffer.concat(chunks);
      const uploadId = url.searchParams.get("uploadId");
      const number = Number(url.searchParams.get("partNumber"));
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(`<InitiateMultipartUploadResult><Bucket>test-1250000000</Bucket><Key>${key}</Key><UploadId>test-upload</UploadId></InitiateMultipartUploadResult>`);
      } else if (req.method === "PUT" && uploadId && number) {
        if (number === failPart) {
          res.writeHead(503, { "content-type": "application/xml" });
          res.end("<Error><Code>ServiceUnavailable</Code><Message>synthetic failure</Message></Error>");
        } else {
          parts.set(number, body);
          res.writeHead(200, { etag: `"part-${number}"` });
          res.end();
        }
      } else if (req.method === "POST" && uploadId) {
        objects.set(key, { body: Buffer.concat([...parts.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes)) });
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(`<CompleteMultipartUploadResult><Bucket>test-1250000000</Bucket><Key>${key}</Key><ETag>"combined"</ETag></CompleteMultipartUploadResult>`);
      } else if (req.method === "DELETE" && uploadId) {
        abortCount += 1;
        res.writeHead(204); res.end();
      } else if (req.method === "PUT") {
        objects.set(key, { body, encoding: req.headers["content-encoding"] });
        res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` }); res.end();
      } else if (req.method === "GET") {
        const object = objects.get(key);
        if (!object) {
          res.writeHead(404, { "content-type": "application/xml" });
          res.end("<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>");
          return;
        }
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
        if (range) {
          const start = Number(range[1]); const end = Number(range[2]);
          const content = object.body.subarray(start, end + 1);
          res.writeHead(206, { "content-length": content.length, "content-range": `bytes ${start}-${end}/${object.body.length}` });
          res.end(content);
        } else {
          res.writeHead(200, { "content-length": object.body.length, ...(object.encoding ? { "content-encoding": object.encoding } : {}) });
          res.end(object.body);
        }
      } else {
        res.writeHead(400); res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  store = new CosFileStore({ bucket: "test-1250000000", region: "ap-guangzhou", prefix: "synthetic-test",
    secretId: "test-id", secretKey: "test-key" });
  (store as any).cos = new COS({ SecretId: "test-id", SecretKey: "test-key", Domain: `127.0.0.1:${port}`,
    Protocol: "http:", Timeout: 3_000, ChunkRetryTimes: 0 });
});

beforeEach(() => { objects.clear(); parts.clear(); abortCount = 0; failPart = 0; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

describe("COS adapter using the real SDK against synthetic loopback HTTP", () => {
  it("commits and reopens a manifest and content through the SDK", async () => {
    const dir = await mkdtemp(join(tmpdir(), "websync-cos-http-"));
    try {
      const options = { dataDir: dir, vaultId: "synthetic-vault", fileStore: store };
      const manifest = await ManifestStore.open(options);
      const content = Buffer.from("synthetic note only");
      const result = await manifest.applyPut({ opId: "test-operation", path: "note.md", content,
        hash: createHash("sha256").update(content).digest("hex"), size: content.length, baseRevision: 0,
        deviceId: "synthetic-device", deviceName: "Synthetic", mtime: 1 });
      expect(result.kind).toBe("accepted");
      const reopened = await ManifestStore.open(options);
      expect(reopened.snapshot().revision).toBe(1);
      expect(await reopened.readEntryContent(reopened.snapshot().files["note.md"])).toEqual(content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips an SDK-uploaded compressed manifest", async () => {
    const manifest = Buffer.from('{"revision":1,"files":{}}');
    await store.putManifest(manifest);
    expect(objects.get("synthetic-test/meta/manifest.json")?.encoding).toBe("gzip");
    expect(await store.getManifest()).toEqual(manifest);
  });

  it("streams a multipart blob through the SDK and reads only the requested range", async () => {
    const content = Buffer.alloc(1024 * 1024 + 17, 23);
    const hash = createHash("sha256").update(content).digest("hex");
    await store.putBlob(hash, content);
    expect(parts.size).toBe(2);
    expect(await store.getBlob(hash)).toEqual(content);
    expect(await store.getBlobRange(hash, 100, 7)).toEqual(content.subarray(100, 107));
  });

  it("maps missing objects and aborts a failed SDK multipart upload", async () => {
    expect(await store.getBlob("a".repeat(64))).toBeUndefined();
    failPart = 2;
    await expect(store.putBlob("b".repeat(64), Buffer.alloc(1024 * 1024 + 2))).rejects.toBeDefined();
    expect(abortCount).toBe(1);
    expect(objects.has(`synthetic-test/blobs/sha256/${"b".repeat(64)}`)).toBe(false);
  });
});
