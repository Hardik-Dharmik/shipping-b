const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { employeePageGuard } = require('../utils/permissions');

let calls = [];
let results = [];
const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub('../supabase', { supabaseAdmin: { from(table) {
  const call = { table, operations: [] };
  calls.push(call);
  const result = results.shift() || { count: 0, error: null };
  const builder = {};
  for (const method of ['select', 'eq']) {
    builder[method] = (...args) => { call.operations.push([method, ...args]); return builder; };
  }
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return builder;
} } });
stub('../routes/auth', { authenticateToken(req, res, next) {
  if (!req.headers.authorization) return res.status(401).json({ success: false });
  req.user = { role: req.headers['x-role'] || 'admin', page_permissions: (req.headers['x-pages'] || '').split(',') };
  return employeePageGuard(req, res, next);
} });
const app = express();
app.use('/api/analytics', require('../routes/analytics'));
let server, base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/analytics`;
});
after(() => new Promise(resolve => server.close(resolve)));

test('returns exact global counts and filters KYC to required accounts by status', async () => {
  calls = [];
  results = [1501, 47, 8, 30, 9].map(count => ({ count, error: null }));
  const response = await fetch(base, { headers: { authorization: 'Bearer test' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, data: {
    totalOrders: 1501, totalCustomers: 47, pendingKyc: 8, completedKyc: 30, notStartedKyc: 9
  } });
  assert.deepEqual(calls.map(call => call.table), ['orders', 'customers', 'users', 'users', 'users']);
  for (const call of calls) assert.deepEqual(call.operations[0], ['select', 'id', { count: 'exact', head: true }]);
  assert.equal(calls[0].operations.length, 1);
  assert.equal(calls[1].operations.length, 1);
  ['pending', 'completed', 'not_started'].forEach((status, index) => {
    assert.deepEqual(calls[index + 2].operations.slice(1), [['eq', 'kyc_required', true], ['eq', 'kyc_status', status]]);
  });
});

test('home employees can read zero counts', async () => {
  results = [];
  const response = await fetch(base, { headers: { authorization: 'Bearer test', 'x-role': 'employee', 'x-pages': 'home' } });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.values((await response.json()).data), [0, 0, 0, 0, 0]);
});

test('unauthenticated users, ordinary users and employees without Home cannot read global counts', async () => {
  for (const [headers, status] of [
    [{}, 401],
    [{ authorization: 'Bearer test', 'x-role': 'user' }, 403],
    [{ authorization: 'Bearer test', 'x-role': 'employee', 'x-pages': 'customers' }, 403]
  ]) {
    calls = [];
    assert.equal((await fetch(base, { headers })).status, status);
    assert.equal(calls.length, 0);
  }
});

test('database errors and unavailable counts fail without leaking details or partial totals', async () => {
  for (const failure of [{ error: { message: 'private database detail' }, count: null }, { count: null, error: null }]) {
    results = [{ count: 5 }, failure];
    const response = await fetch(base, { headers: { authorization: 'Bearer test' } });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { success: false, error: 'Unable to load analytics' });
  }
});
