import { json, atomicJson, fail } from './storage.mjs';

export function decodeMapping(document) {
  if (!document || Array.isArray(document) || typeof document !== 'object') fail('MAPPING_FORMAT', 'Unsupported mapping document; original file was preserved.');
  const format = document.mapping && typeof document.mapping === 'object' ? 'mapping' :
    document.tasks && typeof document.tasks === 'object' ? 'tasks' : 'flat';
  const records = format === 'flat' ? document : document[format];
  if (Array.isArray(records)) fail('MAPPING_FORMAT', 'The task mapping must be an object.');
  const mapping = {};
  for (const [taskId, record] of Object.entries(records)) {
    const id = typeof record === 'string' ? record : record?.yougileId;
    if (!id || typeof id !== 'string') fail('MAPPING_FORMAT', 'Unsupported mapping entry; no conversion was applied.');
    mapping[taskId] = id;
  }
  if (new Set(Object.values(mapping)).size !== Object.keys(mapping).length) fail('DUPLICATE_MAPPING', 'Several local tasks reference the same remote card.');
  return { document, format, records, mapping };
}
export async function saveMappingEntry(path, taskId, remoteId, nativeFingerprint) {
  const decoded = decodeMapping(await json(path, {}));
  const previous = decoded.records[taskId];
  if (decoded.mapping[taskId] && decoded.mapping[taskId] !== remoteId) fail('MAPPING_CHANGED', 'The task already points to another remote card; mapping was preserved.');
  decoded.records[taskId] = decoded.format === 'tasks' || (previous && typeof previous === 'object')
    ? { ...(typeof previous === 'object' ? previous : {}), yougileId: remoteId, ...(nativeFingerprint ? { fingerprint: nativeFingerprint } : {}) }
    : remoteId;
  await atomicJson(path, decoded.document);
}
