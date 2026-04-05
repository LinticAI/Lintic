function stableSerialize(value, options = {}, seen = new Map()) {
  if (value === null) {
    return 'null';
  }

  const valueType = typeof value;
  if (valueType === 'undefined') {
    return 'undefined';
  }
  if (valueType === 'number' || valueType === 'boolean' || valueType === 'bigint') {
    return `${valueType}:${String(value)}`;
  }
  if (valueType === 'string') {
    return `string:${JSON.stringify(value)}`;
  }
  if (valueType === 'symbol') {
    return `symbol:${String(value)}`;
  }
  if (valueType === 'function') {
    return `function:${value.name || '<anonymous>'}`;
  }

  if (seen.has(value)) {
    return `circular:${seen.get(value)}`;
  }
  seen.set(value, seen.size);

  if (value instanceof Date) {
    return `date:${value.toISOString()}`;
  }
  if (value instanceof RegExp) {
    return `regexp:${value.toString()}`;
  }
  if (ArrayBuffer.isView(value)) {
    return `${value.constructor.name}:${Array.from(value).join(',')}`;
  }
  if (value instanceof ArrayBuffer) {
    return `ArrayBuffer:${Array.from(new Uint8Array(value)).join(',')}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item, options, seen)).join(',')}]`;
  }
  if (value instanceof Set) {
    const entries = Array.from(value, (item) => stableSerialize(item, options, seen)).sort();
    return `set:${entries.join('|')}`;
  }
  if (value instanceof Map) {
    const entries = Array.from(value.entries(), ([key, item]) => (
      `${stableSerialize(key, options, seen)}=>${stableSerialize(item, options, seen)}`
    )).sort();
    return `map:${entries.join('|')}`;
  }

  const objectValue = value;
  const keys = Object.keys(objectValue).sort();
  const pairs = keys.map((key) => {
    const serializedValue = options.excludeValues
      ? '[value]'
      : stableSerialize(objectValue[key], options, seen);
    return `${JSON.stringify(key)}:${serializedValue}`;
  });
  return `{${pairs.join(',')}}`;
}

function hashString(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function objectHash(value, options = {}) {
  const serialized = stableSerialize(value, options);
  const digest = hashString(serialized);
  return options.encoding === 'buffer'
    ? new TextEncoder().encode(digest)
    : digest;
}

objectHash.sha1 = function sha1(value) {
  return objectHash(value, { algorithm: 'sha1', encoding: 'hex' });
};

objectHash.keys = function keys(value) {
  return objectHash(value, {
    algorithm: 'sha1',
    encoding: 'hex',
    excludeValues: true,
  });
};

objectHash.MD5 = function MD5(value) {
  return objectHash(value, { algorithm: 'md5', encoding: 'hex' });
};

objectHash.keysMD5 = function keysMD5(value) {
  return objectHash(value, {
    algorithm: 'md5',
    encoding: 'hex',
    excludeValues: true,
  });
};

objectHash.writeToStream = function writeToStream(value, options, stream) {
  let resolvedOptions = options;
  let resolvedStream = stream;
  if (resolvedStream === undefined) {
    resolvedStream = options;
    resolvedOptions = {};
  }

  const serialized = stableSerialize(value, resolvedOptions ?? {});
  if (typeof resolvedStream.update === 'function') {
    resolvedStream.update(serialized, 'utf8');
    return;
  }
  if (typeof resolvedStream.write === 'function') {
    resolvedStream.write(serialized, 'utf8');
  }
};

export default objectHash;
