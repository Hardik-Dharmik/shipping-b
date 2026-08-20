const { fedexConfig, assertFedExConfigured } = require('./config');

let accessToken;
let accessTokenExpiresAt = 0;
let tokenRequest;

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fedexConfig.requestTimeoutMs);

  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

async function readResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function createFedExError(message, response, body) {
  const details = body?.errors?.map((item) => ({
    code: item.code,
    message: item.message
  })) || [];
  const fedexMessage = details.map((item) => item.message).filter(Boolean).join('; ');
  const error = new Error(fedexMessage || body?.message || message);
  error.statusCode = response?.status >= 400 && response.status < 500 ? 422 : 502;
  error.code = 'FEDEX_API_ERROR';
  error.details = details;
  error.fedexTransactionId = body?.transactionId;
  return error;
}

function logFedExFailure(path, response, body) {
  console.error('FedEx API request failed', {
    path,
    status: response.status,
    transactionId: body?.transactionId,
    errors: body?.errors || [],
    message: body?.message
  });
}

function redactForLog(value, key = '') {
  const sensitiveKeys = new Set(['client_id', 'client_secret', 'child_key', 'child_secret', 'authorization']);
  if (sensitiveKeys.has(key.toLowerCase())) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactForLog(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactForLog(entryValue, entryKey)
    ]));
  }
  return value;
}

function logFedExPayload(path, payload) {
  if (!fedexConfig.logPayloads) return;
  console.log(`FedEx API request payload [${path}]: ${JSON.stringify(redactForLog(payload))}`);
}

async function requestAccessToken() {
  assertFedExConfigured();

  const form = new URLSearchParams({
    grant_type: fedexConfig.grantType,
    client_id: fedexConfig.clientId,
    client_secret: fedexConfig.clientSecret
  });

  if (fedexConfig.childKey) form.set('child_key', fedexConfig.childKey);
  if (fedexConfig.childSecret) form.set('child_secret', fedexConfig.childSecret);

  let response;
  try {
    response = await fetchWithTimeout(`${fedexConfig.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
  } catch (cause) {
    const error = new Error('Unable to connect to FedEx authorization service');
    error.statusCode = 502;
    error.code = 'FEDEX_CONNECTION_ERROR';
    error.cause = cause;
    throw error;
  }

  const body = await readResponse(response);
  if (!response.ok || !body.access_token) {
    logFedExFailure('/oauth/token', response, body);
    throw createFedExError('FedEx authorization failed', response, body);
  }

  accessToken = body.access_token;
  // Refresh a minute before expiry; FedEx tokens normally expire in one hour.
  accessTokenExpiresAt = Date.now() + Math.max(Number(body.expires_in || 0) - 60, 1) * 1000;
  return accessToken;
}

async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  if (!tokenRequest) {
    tokenRequest = requestAccessToken().finally(() => { tokenRequest = null; });
  }
  return tokenRequest;
}

async function getRateQuote(payload) {
  return requestFedEx('/rate/v1/rates/quotes', payload, 'FedEx rate request failed');
}

async function requestFedEx(path, payload, errorMessage = 'FedEx API request failed', method = 'POST') {
  const token = await getAccessToken();
  let response;

  try {
    logFedExPayload(path, payload);
    response = await fetchWithTimeout(`${fedexConfig.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-locale': 'en_US'
      },
      body: JSON.stringify(payload)
    });
  } catch (cause) {
    const error = new Error('Unable to connect to FedEx service');
    error.statusCode = 502;
    error.code = 'FEDEX_CONNECTION_ERROR';
    error.cause = cause;
    throw error;
  }

  const body = await readResponse(response);
  if (!response.ok) {
    logFedExFailure(path, response, body);
    throw createFedExError(errorMessage, response, body);
  }
  return body;
}

async function createShipment(payload) {
  return requestFedEx('/ship/v1/shipments', payload, 'FedEx shipment creation failed');
}

async function createPickup(payload) {
  return requestFedEx('/pickup/v1/pickups', payload, 'FedEx pickup scheduling failed');
}

async function cancelPickup(payload) {
  return requestFedEx('/pickup/v1/pickups/cancel', payload, 'FedEx pickup cancellation failed', 'PUT');
}

async function getPickupAvailability(payload) {
  return requestFedEx('/pickup/v1/pickups/availabilities', payload, 'FedEx pickup availability check failed');
}

function validatePostalCode(payload) {
  return requestFedEx('/country/v1/postal/validate', payload, 'FedEx postal code validation failed');
}

function getServiceAvailability(payload) {
  return requestFedEx('/availability/v1/transittimes', payload, 'FedEx service availability check failed');
}

module.exports = {
  getRateQuote,
  createShipment,
  createPickup,
  cancelPickup,
  getPickupAvailability,
  validatePostalCode,
  getServiceAvailability
};
