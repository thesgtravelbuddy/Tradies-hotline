import { timingSafeEqual } from 'node:crypto';

export function ownerTokenMap(value = process.env.OWNER_AUTH_TOKENS ?? '{}') {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch (error) { console.warn('Error parsing OWNER_AUTH_TOKENS, using empty map:', error.message); return {}; }
}

function sameSecret(left, right) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }

export function authenticateOwner(headers, tokens) {
  const token = String(headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const match = Object.entries(tokens).find(([candidate]) => sameSecret(token, candidate));
  return match ? { businessId: match[1] } : null;
}
