const FORBIDDEN_KEY_TOKENS = new Set([
  'api_key',
  'api',
  'authorization',
  'command',
  'confirm',
  'cookie',
  'credential',
  'envelope',
  'executable_envelope',
  'header',
  'headers',
  'http_method',
  'mcp_call',
  'method',
  'mutation',
  'raw_request',
  'request_body',
  'request_bodies',
  'shell_command',
  'shell',
  'tool_call',
  'tool_calls',
  'url',
  'write_tool',
]);
const FORBIDDEN_VALUE = /(?:https?:\/\/|\b(?:GET|POST|PUT|PATCH|DELETE)\s+(?:\/|https?:\/\/)|raw[\s_-]*request|tools?[/.]call|mcp[\s_-]*(?:call|tool)|authorization|credential[\s_-]*value|session[\s_-]*cookie|\bcurl\b|\bwget\b|```|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:create|update|delete|patch|post|put|execute|mutate)\s*\(|\b(?:npm|node|python|bash|zsh|sh|rm|cp|mv|chmod|export)\s+-?[A-Za-z0-9./])/iu;

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function normalizeKey(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

export function assertNoExecutionMaterial(
  value,
  { code = 'PROPOSAL_EXECUTION_MATERIAL_FORBIDDEN' } = {},
) {
  const visit = (current, key = '', seen = new WeakSet()) => {
    const normalized = normalizeKey(key);
    if (
      FORBIDDEN_KEY_TOKENS.has(normalized)
      || normalized.endsWith('_credential')
      || normalized.endsWith('_cookie')
      || normalized.endsWith('_authorization')
    ) throw codedError(`${code}_FIELD`);
    if (typeof current === 'string') {
      if (FORBIDDEN_VALUE.test(current)) throw codedError(`${code}_VALUE`);
      return;
    }
    if (current === null || ['boolean', 'number'].includes(typeof current)) return;
    if (!current || typeof current !== 'object' || seen.has(current)) {
      throw codedError(`${code}_VALUE`, TypeError);
    }
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        for (const child of current) visit(child, key, seen);
      } else {
        for (const [childKey, child] of Object.entries(current)) {
          visit(child, childKey, seen);
        }
      }
    } finally {
      seen.delete(current);
    }
  };
  visit(value);
  return true;
}
