require('dotenv').config({ quiet: true });
process.env.FEDEX_LOG_PAYLOADS = 'false';
const { fedexConfig: config } = require('../fedex/config');
const { toFedExPayload, toCalculatorRateRequest } = require('../fedex/rateService');

async function main() {
  const response = await fetch(`${config.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: config.grantType, client_id: config.clientId, client_secret: config.clientSecret }),
    signal: AbortSignal.timeout(15000)
  });
  const auth = await response.json();
  console.log(JSON.stringify({ step: 'oauth', baseUrl: config.baseUrl, status: response.status, errors: auth.errors }));
  if (!auth.access_token) { process.exitCode = 1; return; }
  const base = toFedExPayload(toCalculatorRateRequest({
    pickupCountry: 'AE', pickupCity: 'DUBAI', destinationCountry: 'IN', destinationPincode: '440002',
    weight: 30, dimensions: { length: 10, width: 20, height: 30 }, shipmentValue: 2000, currency: 'AED'
  }));
  for (const variant of ['current', 'withoutTransit', 'explicitPackaging']) {
    const payload = structuredClone(base);
    if (variant !== 'current') payload.returnTransitTimes = false;
    if (variant === 'explicitPackaging') payload.requestedShipment.packagingType = 'YOUR_PACKAGING';
    const reply = await fetch(`${config.baseUrl}/rate/v1/rates/quotes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)
    });
    const body = await reply.json();
    console.log(JSON.stringify({ variant, status: reply.status, transactionId: body.transactionId, errors: body.errors, quoteCount: body.output?.rateReplyDetails?.length }));
  }
}
main().catch(error => { console.error(JSON.stringify({ error: error.message, cause: error.cause?.code })); process.exitCode = 1; });
