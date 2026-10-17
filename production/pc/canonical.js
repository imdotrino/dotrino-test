/**
 * Canonical JSON serialization (sorted keys recursively).
 * Necessary so that signatures match across implementations.
 */
export function canonicalStringify (value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']'
  }
  const keys = Object.keys(value).sort()
  const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k]))
  return '{' + parts.join(',') + '}'
}
