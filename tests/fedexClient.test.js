const { test } = require('node:test');
const assert = require('node:assert/strict');

const configId = require.resolve('../fedex/config');
require.cache[configId] = { id: configId, filename: configId, loaded: true, exports: {
  fedexConfig: { baseUrl: 'https://fedex.invalid', requestTimeoutMs: 1000, logPayloads: false },
  assertFedExConfigured() {}
} };
const { getRateQuote } = require('../fedex/client');

test('FedEx validation parameters survive in API error details and expanded logs', async (t) => {
  const errors = [{
    code: 'INVALID.INPUT.EXCEPTION',
    message: "Validation failed for object='rateInputVO'. Error count: 1",
    parameterList: [{ key: 'field', value: 'requestedShipment.exampleField' }]
  }];
  t.mock.method(global, 'fetch', async (url) => ({
    ok: url.endsWith('/oauth/token'),
    status: url.endsWith('/oauth/token') ? 200 : 422,
    text: async () => JSON.stringify(url.endsWith('/oauth/token')
      ? { access_token: 'test-token', expires_in: 3600 }
      : { transactionId: 'test-transaction', errors })
  }));
  const logs = t.mock.method(console, 'error', () => {});
  await assert.rejects(getRateQuote({}), (error) => {
    assert.equal(error.code, 'FEDEX_API_ERROR');
    assert.equal(error.statusCode, 422);
    assert.equal(error.fedexTransactionId, 'test-transaction');
    assert.deepEqual(error.details, errors);
    return true;
  });
  const logged = JSON.parse(logs.mock.calls[0].arguments[1]);
  assert.deepEqual(logged.errors, errors);
  assert.equal(logged.path, '/rate/v1/rates/quotes');
});

test('FedEx errors without validation parameters retain their existing shape', async (t) => {
  t.mock.method(global, 'fetch', async () => ({
    ok: false, status: 503,
    text: async () => JSON.stringify({ errors: [{ code: 'UNAVAILABLE', message: 'Try again' }] })
  }));
  t.mock.method(console, 'error', () => {});
  await assert.rejects(getRateQuote({}), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.message, 'Try again');
    assert.deepEqual(error.details, [{ code: 'UNAVAILABLE', message: 'Try again' }]);
    return true;
  });
});
