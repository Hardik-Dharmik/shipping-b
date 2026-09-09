const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

let calls = [];
let results = [];
const db = { from(table) {
  const call = { table, operations: [] };
  calls.push(call);
  const builder = {};
  for (const method of ['select', 'insert', 'update', 'eq', 'order', 'or', 'range', 'limit', 'single', 'maybeSingle', 'ilike', 'filter', 'gte', 'lte']) {
    builder[method] = (...args) => { call.operations.push([method, ...args]); return builder; };
  }
  builder.then = (resolve, reject) => Promise.resolve(results.shift() || { data: [], error: null, count: 0 }).then(resolve, reject);
  return builder;
} };
const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub('../supabase', { supabaseAdmin: db });
stub('../routes/auth', { authenticateToken(req, res, next) {
  if (!req.headers.authorization) return res.sendStatus(401);
  req.user = { id: 'user-a', role: req.headers['x-role'] || 'user' };
  next();
} });
for (const file of ['../fedex/rateService', '../fedex/shipmentService', '../fedex/labelStorage', '../fedex/pickupService', '../ups/rateService', '../ups/shipmentService', '../ups/labelStorage']) stub(file, {});
stub('../fedex/rateService', { calculateValidatedCalculatorRates: async () => ({ quotes: [{ serviceType: 'INTERNATIONAL_ECONOMY' }] }) });
stub('../fedex/shipmentService', { createFedExShipment: async () => ({ trackingNumber: 'awb-test' }) });
stub('../fedex/labelStorage', { uploadFedExLabel: async () => 'https://example.com/label.pdf' });
const { resolveCustomerId } = require('../utils/customers');
const app = express();
app.use(express.json());
app.use('/api/customers', require('../routes/customers'));
app.use('/api/shipping', require('../routes/shipping'));
app.use('/api/address', require('../routes/addressForms'));
let server, base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));
const request = async (path, options = {}) => {
  const response = await fetch(base + path, { ...options, headers: { authorization: 'Bearer test', 'content-type': 'application/json', ...options.headers } });
  return { status: response.status, body: await response.json() };
};
const reset = (...responses) => { calls = []; results = responses; };

test('customer creation delegates ID generation to database and records the creator for audit', async () => {
  reset({ data: { id: '100000', company_name: 'Acme Ltd' }, error: null });
  const response = await request('/api/customers', { method: 'POST', body: JSON.stringify({ id: '999999', user_id: 'other', companyName: ' Acme   Ltd ', email: 'Sales@acme.com', phoneNumber: '+971 50 123 4567' }) });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.id, '100000');
  assert.deepEqual(calls[0].operations.find(op => op[0] === 'insert')[1], { user_id: 'user-a', company_name: 'Acme Ltd', email: 'sales@acme.com', phone_number: '+971 50 123 4567' });
});

test('customer creation rejects invalid fields before database access', async () => {
  for (const change of [{ companyName: '' }, { email: 'bad' }, { phoneNumber: 1234567 }]) {
    reset();
    const response = await request('/api/customers', { method: 'POST', body: JSON.stringify({ companyName: 'Acme', email: 'a@b.com', phoneNumber: '1234567', ...change }) });
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  }
});

test('customer routes require authentication', async () => {
  const response = await fetch(base + '/api/customers');
  assert.equal(response.status, 401);
});

test('suggestions are shared, cap results, and safely quote search punctuation', async () => {
  reset({ data: [{ id: '100000' }], error: null });
  const response = await request('/api/customers/suggestions?limit=100&query=' + encodeURIComponent('Acme, ("Ltd")'));
  assert.equal(response.status, 200);
  assert.ok(!calls[0].operations.some(op => op[0] === 'eq' && op[1] === 'user_id'));
  assert.deepEqual(calls[0].operations.find(op => op[0] === 'range'), ['range', 0, 19]);
  assert.ok(calls[0].operations.find(op => op[0] === 'or')[1].includes('company_name.ilike."%Acme, (\\"Ltd\\")%"'));
});

test('customer detail is available regardless of creator', async () => {
  reset({ data: { id: '100000', user_id: 'other-user' }, error: null });
  const response = await request('/api/customers/100000');
  assert.equal(response.status, 200);
  assert.ok(!calls[0].operations.some(op => op[0] === 'eq' && op[1] === 'user_id'));
});

test('customer resolver inherits a link selection and rejects substitutions and missing customers', async () => {
  reset({ data: { id: '100000' }, error: null });
  assert.equal(await resolveCustomerId(undefined, '100000'), '100000');
  assert.equal(await resolveCustomerId(undefined), null);
  await assert.rejects(resolveCustomerId('100001', '100000'), { statusCode: 400 });
  await assert.rejects(resolveCustomerId(undefined, 100000), { statusCode: 400 });
  reset({ data: null, error: null });
  await assert.rejects(resolveCustomerId('100000'), { statusCode: 404 });
});

test('both order lists filter by customer and include customer details without excluding legacy orders', async () => {
  for (const path of ['/api/shipping/orders', '/api/shipping/orders/user/user-a']) {
    reset({ data: [{ id: 'order-a', customer_id: '100000', customer: { company_name: 'Acme' } }], count: 1, error: null });
    const response = await request(path + '?customerId=100000', { headers: { 'x-role': 'admin' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.data[0].customer.company_name, 'Acme');
    assert.equal(response.body.pagination.filters.customerId, '100000');
    assert.ok(calls[0].operations.some(op => op[0] === 'eq' && op[1] === 'customer_id' && op[2] === '100000'));
    const selection = calls[0].operations.find(op => op[0] === 'select')[1];
    assert.ok(selection.includes('customer:customers!orders_customer_id_fkey'));
    assert.ok(!selection.includes('!inner'));
  }
  reset();
  assert.equal((await request('/api/shipping/orders?customerId=bad')).status, 400);
  assert.equal(calls.length, 0);
});

test('address link persists selected customer', async () => {
  reset({ data: { id: '100000' }, error: null }, { data: { id: 'form-a', code: '123456', customer_id: '100000' }, error: null });
  const response = await request('/api/address/address-forms', { method: 'POST', body: JSON.stringify({ customerId: '100000' }) });
  assert.equal(response.status, 201);
  assert.equal(calls[1].operations.find(op => op[0] === 'insert')[1].customer_id, '100000');
  assert.ok(!calls[0].operations.some(op => op[0] === 'eq' && op[1] === 'user_id'));
});

test('customer list is shared while order lists still restrict the account', async () => {
  reset({ data: [{ id: '100000' }, { id: '100001' }], count: 2 });
  const customers = await request('/api/customers');
  assert.equal(customers.body.data.length, 2);
  assert.ok(!calls[0].operations.some(op => op[0] === 'eq' && op[1] === 'user_id'));
  reset({ data: [], count: 0 });
  await request('/api/shipping/orders?customerId=100000');
  assert.ok(calls[0].operations.some(op => op[0] === 'eq' && op[1] === 'user_id' && op[2] === 'user-a'));
});

test('completed public link returns order-page details after expiry without authentication or mutations', async () => {
  const form = { id: 'form-a', code: '123456', user_id: 'user-a', status: 'ordered', is_submitted: true, order_id: 'order-a', expires_at: '2000-01-01' };
  const order = { id: 'order-a', user_id: 'user-a', awb_number: 'awb-test', carrier: { name: 'FedEx', cost: 25 }, order_data: {} };
  const pickup = { id: 'pickup-a', status: 'SCHEDULED' };
  reset({ data: form }, { data: order }, { data: pickup });
  const response = await fetch(base + '/api/address/address-forms/public/123456');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.read_only, true);
  assert.equal(body.data.order.id, 'order-a');
  assert.equal(body.data.pickup.id, 'pickup-a');
  assert.equal(body.data.costBreakdown.totalCost, 25);
  assert.ok(calls[1].operations.some(op => op[0] === 'eq' && op[1] === 'id' && op[2] === 'order-a'));
  assert.ok(calls[1].operations.some(op => op[0] === 'eq' && op[1] === 'user_id' && op[2] === 'user-a'));
  assert.ok(calls.every(call => call.operations.every(op => !['insert', 'update'].includes(op[0]))));
  reset({ data: order }, { data: pickup });
  const authenticated = await request('/api/shipping/orders/order-a');
  for (const field of ['order', 'pickup', 'costBreakdown', 'carrierCostBreakdown']) {
    assert.deepEqual(body.data[field], authenticated.body.data[field]);
  }
});

test('legacy completed links resolve their saved association; missing orders return 404', async () => {
  reset({ data: { id: 'form-a', user_id: 'user-a', status: 'ordered' } }, { data: null });
  const response = await request('/api/address/address-forms/public/123456');
  assert.equal(response.status, 404);
  assert.ok(calls[1].operations.some(op => op[0] === 'eq' && op[1] === 'order_data->>createdFromAddressFormId' && op[2] === 'form-a'));
});

test('open links retain form response and completed forms cannot be submitted again', async () => {
  reset({ data: { id: 'form-a', user_id: 'user-a', status: 'open', is_submitted: false, order_data: { privateDraft: true } } });
  const open = await request('/api/address/address-forms/public/123456');
  assert.equal(open.status, 200);
  assert.equal(open.body.data.order_data, undefined);
  assert.equal(open.body.data.user_id, undefined);
  reset({ data: { id: 'form-a', status: 'ordered', is_submitted: true } });
  const repeated = await request('/api/address/address-forms/public/123456', { method: 'POST', body: JSON.stringify({ pickupAddress: {}, destinationAddress: {} }) });
  assert.equal(repeated.status, 400);
  assert.equal(calls.length, 1);
});

test('direct orders reject a missing customer before shipment creation', async () => {
  reset({ data: null, error: null });
  const response = await request('/api/shipping/order', { method: 'POST', body: JSON.stringify({ customerId: '100000', pickupCountry: 'AE', pickupPincode: '12345', destinationCountry: 'IN', destinationPincode: '400001', actualWeight: 1, carrier: { name: 'FedEx' }, boxes: [{ quantity: 1, actualWeight: 1, length: 10, breadth: 10, height: 10 }] }) });
  assert.equal(response.status, 404);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, 'customers');
});

test('order-link creation saves customer and public completion inherits it despite a substituted body ID', async () => {
  const draft = { customerId: '100000', pickupCountry: 'AE', pickupPincode: '12345', destinationCountry: 'IN', destinationPincode: '400001', actualWeight: 1, carrier: { name: 'FedEx', serviceType: 'INTERNATIONAL_ECONOMY' }, boxes: [{ quantity: 1, actualWeight: 1, length: 10, breadth: 10, height: 10 }] };
  const form = { id: 'form-a', code: '123456', user_id: 'user-a', customer_id: '100000', form_type: 'order', status: 'open', is_submitted: false, order_data: draft };
  reset({ data: { id: '100000' } }, { data: form });
  const created = await request('/api/address/address-forms/order-link', { method: 'POST', body: JSON.stringify({ order: draft }) });
  assert.equal(created.status, 201);
  assert.equal(calls[1].operations.find(op => op[0] === 'insert')[1].customer_id, '100000');

  reset({ data: form }, { data: { ...form, is_submitted: true } }, { data: { id: '100000' } }, { data: { id: 'user-a' } }, { data: { id: 'order-a', customer_id: '100000', awb_number: 'awb-test' } }, { data: { ...form, status: 'ordered' } });
  const completed = await request('/api/address/address-forms/public/123456', { method: 'POST', body: JSON.stringify({ customerId: '100001', pickupAddress: { company: 'Sender' }, destinationAddress: { company: 'Recipient' } }) });
  assert.equal(completed.status, 201);
  const orderInsert = calls.find(call => call.table === 'orders').operations.find(op => op[0] === 'insert')[1];
  assert.equal(orderInsert.customer_id, '100000');
  assert.equal(orderInsert.user_id, 'user-a');
});
