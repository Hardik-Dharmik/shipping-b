const { test } = require('node:test');
const assert = require('node:assert/strict');
const calls = [];
const id = require.resolve('../fedex/client');
require.cache[id] = { id, filename: id, loaded: true, exports: {
  validatePostalCode: async (payload) => { calls.push(['postal', payload]); return { output: { valid: true } }; },
  getServiceAvailability: async (payload) => { calls.push(['availability', payload]); return { output: {} }; },
  getRateQuote: async (payload) => { calls.push(['rates', payload]); return { output: { rateReplyDetails: [] } }; }
} };
const { toFedExPayload, toCalculatorRateRequest, calculateValidatedCalculatorRates } = require('../fedex/rateService');
const base = { pickupCountry: 'UAE', pickupPincode: 'Dubai', destinationCountry: 'IN', destinationPincode: '440002', weight: 30, shipmentValue: 2000, currency: 'AED' };
const payload = (input) => toFedExPayload(toCalculatorRateRequest(input));
test('legacy UAE city becomes a city while Indian postal code and customs value remain intact', () => {
  const result = payload(base);
  assert.deepEqual(result.requestedShipment.shipper.address, { countryCode: 'AE', city: 'Dubai', postalCode: '00000' });
  assert.equal(result.requestedShipment.recipient.address.postalCode, '440002');
  assert.deepEqual(result.requestedShipment.customsClearanceDetail.commodities[0].customsValue, { amount: 2000, currency: 'AED' });
});
test('explicit UAE city works without a postal code in either direction', () => {
  assert.equal(payload({ ...base, pickupPincode: undefined, pickupCity: ' Abu Dhabi ' }).requestedShipment.shipper.address.city, 'Abu Dhabi');
  const result = payload({ ...base, pickupCountry: 'IN', pickupPincode: '440002', destinationCountry: 'AE', destinationPincode: undefined, destinationCity: 'Dubai' });
  assert.deepEqual(result.requestedShipment.recipient.address, { countryCode: 'AE', city: 'Dubai', postalCode: '00000' });
});
test('explicit city takes precedence over legacy city and numeric placeholders remain supported', () => {
  assert.equal(payload({ ...base, pickupCity: 'Abu Dhabi' }).requestedShipment.shipper.address.city, 'Abu Dhabi');
  assert.equal(payload({ ...base, pickupPincode: '12345', pickupCity: 'Dubai' }).requestedShipment.shipper.address.postalCode, '12345');
});
test('missing UAE location and missing postal code in postal countries are rejected', () => {
  assert.throws(() => payload({ ...base, pickupPincode: '', pickupCity: ' ' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => payload({ ...base, destinationPincode: '', destinationCity: 'Nagpur' }), { code: 'VALIDATION_ERROR' });
  assert.equal(payload({ ...base, pickupCountry: 'GB', pickupPincode: 'SW1A 1AA' }).requestedShipment.shipper.address.postalCode, 'SW1A 1AA');
});
test('transit times default on and can be disabled', () => {
  assert.equal(payload(base).returnTransitTimes, true);
  assert.equal(payload({ ...base, returnTransitTimes: false }).returnTransitTimes, false);
});
test('validated quotes skip UAE postal validation but still check destination and service availability', async () => {
  calls.length = 0;
  const result = await calculateValidatedCalculatorRates(base);
  assert.equal(result.validation.origin.skipped, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['postal', 'availability', 'rates']);
  assert.equal(calls[0][1].countryCode, 'IN');
  assert.deepEqual(calls[1][1].requestedShipment.shipper.address, { countryCode: 'AE', city: 'Dubai', postalCode: '00000' });
});
test('currency belongs to requestedShipment and requests preferred rates', () => {
  const result = payload(base);
  assert.equal(Object.hasOwn(result, 'preferredCurrency'), false);
  assert.equal(result.requestedShipment.preferredCurrency, 'AED');
  assert.deepEqual(result.requestedShipment.rateRequestType, ['ACCOUNT', 'PREFERRED']);
  assert.equal(result.requestedShipment.packagingType, 'YOUR_PACKAGING');
});
test('calculator preserves explicit rate options without mutating the caller', () => {
  const rateRequestType = ['LIST', 'PREFERRED'];
  const result = payload({ ...base, currency: 'EUR', rateRequestType, packagingType: 'FEDEX_BOX', shipDateStamp: '2026-09-14' });
  assert.deepEqual(result.requestedShipment.rateRequestType, ['LIST', 'PREFERRED']);
  assert.deepEqual(rateRequestType, ['LIST', 'PREFERRED']);
  assert.equal(result.requestedShipment.preferredCurrency, 'EUR');
  assert.equal(result.requestedShipment.packagingType, 'FEDEX_BOX');
  assert.equal(result.requestedShipment.shipDateStamp, '2026-09-14');
});
test('response prefers converted rates and falls back to account rates', () => {
  const { normalizeRateResponse } = require('../fedex/rateService');
  const account = { rateType: 'ACCOUNT', currency: 'USD', totalNetCharge: 100 };
  const preferred = { rateType: 'PREFERRED', currency: 'AED', totalNetCharge: 367 };
  const response = normalizeRateResponse({ output: { rateReplyDetails: [
    { ratedShipmentDetails: [account, preferred] },
    { ratedShipmentDetails: [account] }
  ] } });
  assert.equal(response.quotes[0].currency, 'AED');
  assert.equal(response.quotes[0].totalNetCharge, 367);
  assert.equal(response.quotes[1].currency, 'USD');
});

test('validated India-to-UAE quotes send a postal placeholder to availability and rates', async () => {
  calls.length = 0;
  const result = await calculateValidatedCalculatorRates({
    ...base, pickupCountry: 'IN', pickupPincode: '440002',
    destinationCountry: 'AE', destinationPincode: '', destinationCity: ' Dubai '
  });
  assert.equal(result.validation.destination.skipped, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['postal', 'availability', 'rates']);
  const expected = { countryCode: 'AE', city: 'Dubai', postalCode: '00000' };
  assert.deepEqual(calls[1][1].requestedShipment.recipients[0].address, expected);
  assert.deepEqual(calls[2][1].requestedShipment.recipient.address, expected);
});
