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
  const error = new Error(message);
  error.statusCode = response?.status === 401 ? 502 : 502;
  error.code = 'FEDEX_API_ERROR';
  error.details = body?.errors?.map((item) => ({
    code: item.code,
    message: item.message
  })) || [];
  return error;
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
  return requestFedEx('/rate/v1/rates/quotes', payload);
}

async function requestFedEx(path, payload) {
  const token = await getAccessToken();
  let response;

  try {
    response = await fetchWithTimeout(`${fedexConfig.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-locale': 'en_US'
      },
      body: JSON.stringify(payload)
    });
    console.log(JSON.stringify(response))
  } catch (cause) {
    const error = new Error('Unable to connect to FedEx rate service');
    error.statusCode = 502;
    error.code = 'FEDEX_CONNECTION_ERROR';
    error.cause = cause;
    throw error;
  }

  const body = await readResponse(response);
  if (!response.ok) throw createFedExError('FedEx rate request failed', response, body);
  return body;
}

async function createShipment(payload) {
  try {
    return await requestFedEx('/ship/v1/shipments', payload);
  } catch (error) {
    if (error.code === 'FEDEX_API_ERROR') error.message = 'FedEx shipment creation failed';
    throw error;
  }
}

module.exports = { getRateQuote, createShipment };
