const { upsConfig, assertUPSConfigured } = require('./config');

let accessToken;
let accessTokenExpiresAt = 0;
let tokenRequest;

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), upsConfig.requestTimeoutMs);

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

function createUPSError(message, response, body) {
  const details = body?.errors || [];
  const error = new Error(body?.message || message);
  error.statusCode = response?.status >= 400 && response.status < 500 ? 422 : 502;
  error.code = 'UPS_API_ERROR';
  error.details = details;
  return error;
}

function logUPSPayload(path, payload) {
  if (!upsConfig.logPayloads) return;
  console.log(`UPS API request payload [${path}]: ${JSON.stringify(payload)}`);
}

async function requestUPS(path, payload, errorMessage = 'UPS API request failed') {
  assertUPSConfigured();
  let response;
  try {
    logUPSPayload(path, payload);
    response = await fetchWithTimeout(`${upsConfig.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upsConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (cause) {
    const error = new Error('Unable to connect to UPS service');
    error.statusCode = 502;
    error.code = 'UPS_CONNECTION_ERROR';
    error.cause = cause;
    throw error;
  }

  const body = await readResponse(response);
  if (!response.ok) {
    throw createUPSError(errorMessage, response, body);
  }
  return body;
}

async function getRateQuote(payload) {
  return requestUPS('/rates', payload, 'UPS rate request failed');
}

async function createShipment(payload) {
  return requestUPS('/shipments', payload, 'UPS shipment creation failed');
}

function validatePostalCode(payload) {
  return requestUPS('/postal/validate', payload, 'UPS postal code validation failed');
}

function getServiceAvailability(payload) {
  return requestUPS('/availability', payload, 'UPS service availability check failed');
}

module.exports = { getRateQuote, createShipment, validatePostalCode, getServiceAvailability };
