const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withRateResponseDefaults } = require('../utils/rateResponseDefaults');

test('fills absent calculator fields and labels placeholders without changing live values', () => {
  const input = { pickup: { country: 'AE' }, dimensions: null, quotes: [{
    carrier: 'FedEx', cost: 120, estimatedDeliveryDays: null,
    serviceName: '', customerMessages: [],
    costBreakdown: { ratePerKg: 0, fedexCharges: { totalQuotedCharge: 120 } }
  }] };
  const original = structuredClone(input);
  const result = withRateResponseDefaults(input);
  assert.equal(result.pickup.pincode, '00000');
  assert.equal(result.dimensions.length, 30);
  assert.equal(result.quotes[0].cost, 120);
  assert.equal(result.quotes[0].estimatedDeliveryDays, 5);
  assert.equal(result.quotes[0].serviceName, 'FedEx International Priority');
  assert.equal(result.quotes[0].costBreakdown.fedexCharges.totalQuotedCharge, 120);
  assert.ok(result.dummyFields.includes('quotes[0].estimatedDeliveryDays'));
  assert.ok(!result.dummyFields.includes('quotes[0].costBreakdown.ratePerKg'));
  assert.deepEqual(input, original);
});

test('does not create dummy carrier quotes when no rates are available', () => {
  assert.deepEqual(withRateResponseDefaults({ quotes: [] }).quotes, []);
});

test('sample delivery dates are valid and amounts match the existing total', () => {
  const result = withRateResponseDefaults({ calculatedAt: '2026-09-24T10:00:00Z', quotes: [{ cost: 120 }] });
  const quote = result.quotes[0];
  assert.equal(quote.estimatedDeliveryDate, '2026-10-01');
  assert.equal(quote.estimatedDeliveryDateTime, '2026-10-01T17:00:00.000Z');
  assert.equal(quote.costBreakdown.baseShippingCost + quote.costBreakdown.additionalCharges, 120);
  assert.ok(!JSON.stringify(result).includes('N/A'));
});
