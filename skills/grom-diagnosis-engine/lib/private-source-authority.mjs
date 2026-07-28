const PRIVATE_KINDS = new Set(['pii', 'credential', 'private-content', 'key-reference']);

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function collectStrings(value, kind, stack = new WeakSet(), output = []) {
  if (typeof value === 'string') {
    if (value.length > 0) output.push(Object.freeze({ kind, privateValue: value }));
    return output;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    throw codedError('PRIVATE_SOURCE_NON_STRING_VALUE', TypeError);
  }
  if (value === null || typeof value === 'boolean') return output;
  if (
    !value
    || typeof value !== 'object'
    || stack.has(value)
    || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  ) throw codedError('PRIVATE_SOURCE_BUNDLE_INVALID', TypeError);
  stack.add(value);
  try {
    for (const entry of Array.isArray(value) ? value : Object.values(value)) {
      collectStrings(entry, kind, stack, output);
    }
    return output;
  } finally {
    stack.delete(value);
  }
}

export function derivePrivateSourceEntries(sources) {
  if (!Array.isArray(sources)) throw codedError('PRIVATE_SOURCE_BUNDLE_INVALID', TypeError);
  const sourceIds = new Set();
  const entries = [];
  for (const source of sources) {
    if (
      !source
      || typeof source !== 'object'
      || Array.isArray(source)
      || Object.getPrototypeOf(source) !== Object.prototype
      || Object.keys(source).length !== 3
      || Object.keys(source).some((key) => !['kind', 'payload', 'sourceId'].includes(key))
      || typeof source.sourceId !== 'string'
      || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/u.test(source.sourceId)
      || sourceIds.has(source.sourceId)
      || !PRIVATE_KINDS.has(source.kind)
    ) throw codedError('PRIVATE_SOURCE_BUNDLE_INVALID', TypeError);
    sourceIds.add(source.sourceId);
    const before = entries.length;
    collectStrings(source.payload, source.kind, new WeakSet(), entries);
    if (entries.length === before) throw codedError('PRIVATE_SOURCE_BUNDLE_INCOMPLETE', TypeError);
  }
  return Object.freeze(entries);
}
