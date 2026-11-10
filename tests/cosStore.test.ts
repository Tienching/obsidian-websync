import { gunzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn(),
  multipartInit: vi.fn(), multipartUpload: vi.fn(), multipartComplete: vi.fn(), multipartAbort: vi.fn()
}));
vi.mock("cos-nodejs-sdk-v5", () => ({ default: vi.fn(function () { return sdk; }) }));

import { CosFileStore } from "../src/server/cosStore";

const store = () => new CosFileStore({ bucket: "test-bucket", region: "test-region", prefix: "/test/", secretId: "test", secretKey: "test" });
const hash = "a".repeat(64);

beforeEach(() => {
  for (const method of Object.values(sdk)) method.mockReset();
  sdk.putObject.mockImplementation((_options, callback) => callback(null, {}));
  sdk.getObject.mockImplementation((_options, callback) => callback(null, { Body: Buffer.from("range") }));
  sdk.multipartInit.mockImplementation((_options, callback) => callback(null, { UploadId: "upload-id" }));
  sdk.multipartUpload.mockImplementation((options, callback) => callback(null, { ETag: `etag-${options.PartNumber}` }));
  sdk.multipartComplete.mockImplementation((_options, callback) => callback(null, {}));
  sdk.multipartAbort.mockImplementation((_options, callback) => callback(null, {}));
});

describe("COS adapter with simulated SDK", () => {
  it("stores blobs at content-addressed keys and rejects invalid hashes", async () => {
    const content = Buffer.from("test contents");
    await store().putBlob(hash, content);
    expect(sdk.putObject).toHaveBeenCalledWith(expect.objectContaining({ Key: `test/blobs/sha256/${hash}`, Body: content }), expect.any(Function));
    await expect(store().putBlob("../invalid", content)).rejects.toThrow("Invalid blob hash");
    expect(sdk.putObject).toHaveBeenCalledTimes(1);
  });

  it("uses an inclusive COS range for blob reads", async () => {
    expect(await store().getBlobRange(hash, 10, 5)).toEqual(Buffer.from("range"));
    expect(sdk.getObject).toHaveBeenCalledWith(expect.objectContaining({ Key: `test/blobs/sha256/${hash}`, Range: "bytes=10-14" }), expect.any(Function));
  });

  it("compresses and reads back the manifest", async () => {
    const content = Buffer.from('{"revision":1}');
    await store().putManifest(content);
    const options = sdk.putObject.mock.calls[0][0];
    expect(options).toMatchObject({ Key: "test/meta/manifest.json", ContentEncoding: "gzip", ContentType: "application/json" });
    expect(gunzipSync(options.Body)).toEqual(content);
    sdk.getObject.mockImplementationOnce((_options, callback) => callback(null, { Body: options.Body }));
    expect(await store().getManifest()).toEqual(content);
  });

  it("uploads large objects in ordered parts and completes only after all succeed", async () => {
    const content = Buffer.alloc(1024 * 1024 + 17, 4);
    await store().putBlob(hash, content);
    expect(sdk.multipartInit).toHaveBeenCalledOnce();
    expect(sdk.multipartUpload).toHaveBeenCalledTimes(2);
    expect(sdk.multipartUpload.mock.calls[0][0]).toMatchObject({ PartNumber: 1, ContentLength: 1024 * 1024 });
    expect(sdk.multipartUpload.mock.calls[1][0]).toMatchObject({ PartNumber: 2, ContentLength: 17 });
    expect(sdk.multipartComplete).toHaveBeenCalledWith(expect.objectContaining({ Parts: [
      { PartNumber: 1, ETag: "etag-1" }, { PartNumber: 2, ETag: "etag-2" }
    ] }), expect.any(Function));
    expect(sdk.multipartAbort).not.toHaveBeenCalled();
  });

  it("aborts a multipart upload when any part fails", async () => {
    sdk.multipartUpload.mockImplementationOnce((_options, callback) => callback(new Error("test network error")));
    await expect(store().putBlob(hash, Buffer.alloc(1024 * 1024 + 1))).rejects.toThrow("test network error");
    expect(sdk.multipartAbort).toHaveBeenCalledOnce();
    expect(sdk.multipartComplete).not.toHaveBeenCalled();
  });
});
