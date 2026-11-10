const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSafePrefix, assertEmpty, cleanupExact, inspect } = require('./realCosSafety.cjs');
const prefix = 'codex-websync-validation-4c7e9ec5-33a1-47b9-a681-9f1f921bafd3';
const key = `${prefix}/example`;
const location = { Bucket: 'synthetic', Region: 'synthetic' };

function fake({ versions = [], current = [], uploads = [], truncated = 'false' } = {}) {
  const calls = [];
  return {
    calls,
    async getBucket() { return { IsTruncated: truncated, Contents: current }; },
    async listObjectVersions() { return { IsTruncated: truncated, Versions: versions, DeleteMarkers: [] }; },
    async multipartList() { return { IsTruncated: truncated, Upload: uploads }; },
    async multipartAbort(input) { calls.push(input); uploads = uploads.filter((u) => u.UploadId !== input.UploadId); },
    async deleteObject(input) {
      calls.push(input);
      versions = versions.filter((v) => v.VersionId !== input.VersionId);
      current = [];
    }
  };
}

test('only a separate random prefix is accepted', () => {
  assert.doesNotThrow(() => assertSafePrefix(prefix, '_websync'));
  for (const production of ['', 'codex', prefix, `${prefix}/x`]) {
    assert.throws(() => assertSafePrefix(prefix, production));
  }
  assert.throws(() => assertSafePrefix('_websync', '_websync'));
});
test('exact versions and uploads are cleaned and then verified', async () => {
  const cos = fake({ current: [{ Key: key }], versions: [{ Key: key, VersionId: 'v1' }, { Key: key, VersionId: 'v2' }], uploads: [{ Key: key, UploadId: 'u1' }] });
  assert.deepEqual(await cleanupExact(cos, location, prefix, '_websync', new Set([key])), { versions: 2, uploads: 1 });
  assert.deepEqual(cos.calls.map((call) => [call.Key, call.VersionId || call.UploadId]), [[key, 'u1'], [key, 'v1'], [key, 'v2']]);
});
test('unexpected objects, missing version IDs, and truncated listings cause no deletion', async () => {
  for (const settings of [
    { versions: [{ Key: `${prefix}/unknown`, VersionId: 'v1' }] },
    { versions: [{ Key: key }] },
    { uploads: [{ Key: key }] },
    { truncated: 'true', versions: [{ Key: key, VersionId: 'v1' }] }
  ]) {
    const cos = fake(settings);
    await assert.rejects(cleanupExact(cos, location, prefix, '_websync', new Set([key])));
    assert.equal(cos.calls.length, 0);
  }
});
test('preflight refuses a populated prefix', async () => {
  await assert.rejects(assertEmpty(fake({ current: [{ Key: key }] }), location, prefix));
});
test('enumerates and cleans every exact version across pages', async () => {
  let entries = ['v1', 'v2', 'v3'].map((VersionId) => ({ Key: key, VersionId }));
  const queries = [];
  const deleted = [];
  const cos = {
    async getBucket() { return { IsTruncated: 'false', Contents: [] }; },
    async multipartList() { return { IsTruncated: 'false', Upload: [] }; },
    async listObjectVersions(input) {
      queries.push(input);
      if (entries.length === 0) return { IsTruncated: 'false', Versions: [], DeleteMarkers: [] };
      if (!input.KeyMarker) return { IsTruncated: 'true', Versions: entries.slice(0, 2), DeleteMarkers: [], NextKeyMarker: key, NextVersionIdMarker: 'v2' };
      assert.equal(input.KeyMarker, key);
      assert.equal(input.VersionIdMarker, 'v2');
      return { IsTruncated: 'false', Versions: entries.slice(2), DeleteMarkers: [] };
    },
    async deleteObject(input) { deleted.push(input.VersionId); entries = entries.filter((entry) => entry.VersionId !== input.VersionId); }
  };
  assert.deepEqual(await cleanupExact(cos, location, prefix, '_websync', new Set([key]), 2), { versions: 3, uploads: 0 });
  assert.deepEqual(deleted.sort(), ['v1', 'v2', 'v3']);
  assert.equal(queries.some((query) => query.KeyMarker === key && query.VersionIdMarker === 'v2'), true);
});
test('refuses repeated page markers and duplicate entries without deleting', async () => {
  let deletes = 0;
  const cos = {
    async getBucket() { return { IsTruncated: 'false', Contents: [] }; },
    async multipartList() { return { IsTruncated: 'false', Upload: [] }; },
    async listObjectVersions() { return { IsTruncated: 'true', Versions: [{ Key: key, VersionId: 'v1' }],
      DeleteMarkers: [], NextKeyMarker: key, NextVersionIdMarker: 'v1' }; },
    async deleteObject() { deletes += 1; }
  };
  await assert.rejects(cleanupExact(cos, location, prefix, '_websync', new Set([key]), 1));
  assert.equal(deletes, 0);
});
test('paginates current objects and unfinished uploads with bounded XML responses', async () => {
  const key2 = `${prefix}/second`;
  const cos = {
    async getBucket(input) {
      assert.equal(input.MaxKeys, '1');
      return input.Marker ? { IsTruncated: 'false', Contents: [{ Key: key2 }] }
        : { IsTruncated: 'true', Contents: [{ Key: key }], NextMarker: key };
    },
    async listObjectVersions() { return { IsTruncated: 'false', Versions: [], DeleteMarkers: [] }; },
    async multipartList(input) {
      assert.equal(input.MaxUploads, 1);
      return input.KeyMarker ? { IsTruncated: 'false', Upload: [{ Key: key2, UploadId: 'u2' }] }
        : { IsTruncated: 'true', Upload: [{ Key: key, UploadId: 'u1' }], NextKeyMarker: key, NextUploadIdMarker: 'u1' };
    }
  };
  const state = await inspect(cos, location, prefix, 1);
  assert.deepEqual(state.current.map((entry) => entry.Key), [key, key2]);
  assert.deepEqual(state.uploads.map((entry) => entry.UploadId), ['u1', 'u2']);
  await assert.rejects(inspect(cos, location, prefix, 101));
});
