// Fail-closed helpers for synthetic COS verification. Never use on vault keys.
const PREFIX = /^codex-websync-validation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertSafePrefix(prefix, productionPrefix) {
  const production = (productionPrefix ?? '_websync').replace(/^\/+|\/+$/g, '');
  if (!PREFIX.test(prefix) || !production || prefix.startsWith(production) || production.startsWith(prefix)) {
    throw new Error('unsafe-prefix');
  }
}

function isTruncated(result) {
  if (String(result.IsTruncated) === 'true') return true;
  if (String(result.IsTruncated) === 'false') return false;
  throw new Error('listing-truncated-or-unknown');
}

// Keep XML responses small: the installed COS SDK's XML parser enforces an
// entity-expansion limit and can throw asynchronously on very large lists.
async function inspect(cos, location, prefix, pageSize = 100) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('invalid-page-size');
  const options = { ...location, Prefix: `${prefix}/` };
  const current = [];
  const versions = [];
  let marker;
  const markers = new Set();
  for (let page = 0; page < 20; page += 1) {
    const result = await cos.getBucket({ ...options, MaxKeys: String(pageSize), ...(marker === undefined ? {} : { Marker: marker }) });
    if ((result.CommonPrefixes || []).length) throw new Error('unexpected-common-prefix');
    current.push(...(result.Contents || []));
    if (!isTruncated(result)) break;
    marker = result.NextMarker;
    if (typeof marker !== 'string' || !marker.startsWith(`${prefix}/`) || markers.has(marker)) throw new Error('invalid-page-marker');
    markers.add(marker);
    if (page === 19) throw new Error('too-many-pages');
  }
  let keyMarker;
  let versionMarker;
  const versionMarkers = new Set();
  for (let page = 0; page < 20; page += 1) {
    const result = await cos.listObjectVersions({ ...options, MaxKeys: String(pageSize),
      ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker, VersionIdMarker: versionMarker }) });
    if ((result.CommonPrefixes || []).length) throw new Error('unexpected-common-prefix');
    versions.push(...(result.Versions || []), ...(result.DeleteMarkers || []));
    if (!isTruncated(result)) break;
    keyMarker = result.NextKeyMarker;
    versionMarker = result.NextVersionIdMarker ?? '';
    const combined = JSON.stringify([keyMarker, versionMarker]);
    if (typeof keyMarker !== 'string' || !keyMarker.startsWith(`${prefix}/`) || typeof versionMarker !== 'string' || versionMarkers.has(combined)) {
      throw new Error('invalid-version-marker');
    }
    versionMarkers.add(combined);
    if (page === 19) throw new Error('too-many-pages');
  }
  const uploads = [];
  let uploadKeyMarker;
  let uploadIdMarker;
  const uploadMarkers = new Set();
  for (let page = 0; page < 20; page += 1) {
    const result = await cos.multipartList({ ...options, MaxUploads: pageSize,
      ...(uploadKeyMarker === undefined ? {} : { KeyMarker: uploadKeyMarker, UploadIdMarker: uploadIdMarker }) });
    uploads.push(...(result.Upload || []));
    if (!isTruncated(result)) break;
    uploadKeyMarker = result.NextKeyMarker;
    uploadIdMarker = result.NextUploadIdMarker ?? '';
    const combined = JSON.stringify([uploadKeyMarker, uploadIdMarker]);
    if (typeof uploadKeyMarker !== 'string' || !uploadKeyMarker.startsWith(`${prefix}/`) || typeof uploadIdMarker !== 'string' || uploadMarkers.has(combined)) {
      throw new Error('invalid-upload-marker');
    }
    uploadMarkers.add(combined);
    if (page === 19) throw new Error('too-many-pages');
  }
  if (versions.length > 3000 || current.length > 1000 || uploads.length > 1000) throw new Error('too-many-entries');
  if (new Set(current.map((item) => item.Key)).size !== current.length) throw new Error('duplicate-current-object');
  if (new Set(versions.map((item) => JSON.stringify([item.Key, item.VersionId]))).size !== versions.length) throw new Error('duplicate-version');
  if (new Set(uploads.map((item) => JSON.stringify([item.Key, item.UploadId]))).size !== uploads.length) throw new Error('duplicate-upload');
  return { current, versions, uploads };
}

async function assertEmpty(cos, location, prefix, pageSize) {
  const state = await inspect(cos, location, prefix, pageSize);
  if (state.current.length || state.versions.length || state.uploads.length) throw new Error('prefix-not-empty');
}

async function cleanupExact(cos, location, prefix, productionPrefix, allowedKeys, pageSize) {
  assertSafePrefix(prefix, productionPrefix);
  if (!(allowedKeys instanceof Set) || allowedKeys.size < 1 || allowedKeys.size > 600 ||
      [...allowedKeys].some((key) => typeof key !== 'string' || !key.startsWith(`${prefix}/`))) {
    throw new Error('unsafe-allowlist');
  }
  const state = await inspect(cos, location, prefix, pageSize);
  if ([...state.current, ...state.versions, ...state.uploads].some((item) => !allowedKeys.has(item.Key)) ||
      state.versions.some((item) => typeof item.VersionId !== 'string' || item.VersionId.length === 0) ||
      state.uploads.some((item) => typeof item.UploadId !== 'string' || item.UploadId.length === 0)) {
    throw new Error('unexpected-object-or-missing-id');
  }
  // First validate the *whole* listing, then touch only exact allowlisted keys
  // and the versions/upload IDs returned by COS. Never delete a prefix.
  for (const item of state.uploads) {
    await cos.multipartAbort({ ...location, Key: item.Key, UploadId: item.UploadId });
  }
  for (let start = 0; start < state.versions.length; start += 4) {
    const settled = await Promise.allSettled(state.versions.slice(start, start + 4).map((item) =>
      cos.deleteObject({ ...location, Key: item.Key, VersionId: item.VersionId })));
    if (settled.some((item) => item.status === 'rejected')) throw new Error('version-delete-failed');
  }
  await assertEmpty(cos, location, prefix, pageSize);
  return { versions: state.versions.length, uploads: state.uploads.length };
}

module.exports = { assertSafePrefix, assertEmpty, cleanupExact, inspect };
