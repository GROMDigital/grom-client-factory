import { createHash } from 'node:crypto';

function unsupported() {
  throw new TypeError('CANONICAL_JSON_UNSUPPORTED');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalizeArray(value, stack) {
  if (stack.has(value)) unsupported();
  stack.add(value);
  try {
    const propertyNames = Object.getOwnPropertyNames(value);
    if (
      propertyNames.length !== value.length + 1
      || !propertyNames.includes('length')
      || Object.getOwnPropertySymbols(value).length > 0
    ) unsupported();
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) unsupported();
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) unsupported();
      output.push(canonicalize(value[index], stack));
    }
    return output;
  } finally {
    stack.delete(value);
  }
}

function canonicalizeObject(value, stack) {
  if (!isPlainObject(value) || stack.has(value)) unsupported();
  stack.add(value);
  try {
    const propertyNames = Object.getOwnPropertyNames(value);
    if (propertyNames.length !== Object.keys(value).length || Object.getOwnPropertySymbols(value).length > 0) {
      unsupported();
    }
    return Object.fromEntries(propertyNames.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) unsupported();
      return [key, canonicalize(descriptor.value, stack)];
    }));
  } finally {
    stack.delete(value);
  }
}

function canonicalize(value, stack) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) unsupported();
    return value;
  }
  if (Array.isArray(value)) return canonicalizeArray(value, stack);
  if (typeof value === 'object') return canonicalizeObject(value, stack);
  unsupported();
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value, new WeakSet()));
}

export function sha256(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
