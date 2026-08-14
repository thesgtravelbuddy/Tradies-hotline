const synonyms = new Map([
  ['toilet', ['loo', 'wc', 'lavatory']], ['loo', ['toilet']], ['flush', ['pull', 'chain']], ['leak', ['leaking', 'water', 'drip']], ['water', ['leak', 'leaking']], ['sink', ['basin']], ['tap', ['faucet']], ['electricity', ['power', 'electrical']], ['power', ['electricity', 'electrical']]
]);
export function terms(text) { return [...new Set((String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []).flatMap((term) => [term, ...(synonyms.get(term) ?? [])]))]; }
export function embed(text) { const vector = new Map(); for (const term of terms(text)) vector.set(term, (vector.get(term) ?? 0) + 1); return Object.fromEntries(vector); }
export function cosine(left, right) { const keys = new Set([...Object.keys(left), ...Object.keys(right)]); let product = 0, leftSize = 0, rightSize = 0; for (const key of keys) { const a = left[key] ?? 0, b = right[key] ?? 0; product += a * b; leftSize += a * a; rightSize += b * b; } return leftSize && rightSize ? product / Math.sqrt(leftSize * rightSize) : 0; }
