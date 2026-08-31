import { createHash, randomBytes, randomUUID } from 'node:crypto';

const contactMethods = new Set(['phone', 'email']);

export function validateIntake(input, { requiresEmail = false } = {}) {
  const fields = ['name', 'phone', 'serviceAddress', 'preferredContactMethod', 'description'];
  const cleaned = Object.fromEntries(fields.map((key) => [key, String(input[key] ?? '').trim()]));
  cleaned.email = String(input.email ?? '').trim();
  const errors = {};
  for (const field of fields) if (!cleaned[field]) errors[field] = 'Required';
  if (!contactMethods.has(cleaned.preferredContactMethod)) errors.preferredContactMethod = 'Choose phone or email';
  if (requiresEmail && !cleaned.email) errors.email = 'Email is required';
  if (cleaned.email && !/^\S+@\S+\.\S+$/.test(cleaned.email)) errors.email = 'Enter a valid email';
  return { valid: Object.keys(errors).length === 0, errors, value: cleaned };
}

export function createRequest(input, options = {}) {
  const result = validateIntake(input, options);
  if (!result.valid) throw Object.assign(new Error('Invalid intake'), { errors: result.errors });
  const now = new Date().toISOString();
  const { value } = result;
  const businessId = options.businessId ?? input.businessId;
  if (!businessId) throw new Error('Business ID is required');
  const customerAccessToken = randomBytes(32).toString('base64url');
  const customer = { id: randomUUID(), businessId, name: value.name, phone: value.phone, email: value.email || null, serviceAddress: value.serviceAddress, preferredContactMethod: value.preferredContactMethod, createdAt: now };
  const request = { id: randomUUID(), businessId, customerId: customer.id, customerAccessTokenHash: createHash('sha256').update(customerAccessToken).digest('hex'), status: 'NEW', initialDescription: value.description, requestState: {}, createdAt: now, updatedAt: now };
  const message = { id: randomUUID(), requestId: request.id, sender: 'customer', body: value.description, createdAt: now };
  return { customer, request, message, customerAccessToken };
}
