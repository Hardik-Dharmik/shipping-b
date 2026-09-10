const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
process.env.JWT_SECRET = 'employee-test-secret';
let results = [], calls = [];
const db = { from(table) {
  const call = { table, operations: [] }; calls.push(call);
  const builder = {};
  for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'order', 'single', 'maybeSingle']) {
    builder[method] = (...args) => { call.operations.push([method, ...args]); return builder; };
  }
  builder.then = (resolve, reject) => Promise.resolve(results.shift() || { data: null, error: null }).then(resolve, reject);
  return builder;
} };
const id = require.resolve('../supabase');
require.cache[id] = { id, filename: id, loaded: true, exports: { supabaseAdmin: db } };
const auth = require('../routes/auth');
const { requireAdminAccess } = require('../middleware/adminAccess');
const { PAGE_KEYS } = require('../utils/permissions');
const app = express(); app.use(express.json());
app.use('/api/auth', auth);
app.use('/api/admin/employees', require('../routes/employees'));
app.get('/api/admin/users', requireAdminAccess('users'), (req, res) => res.json({ success: true }));
for (const path of ['/api/customers', '/api/shipping/rate-calculator/saved', '/api/shipping/order', '/api/notifications', '/api/shipping/orders', '/api/kyc/requests', '/api/billing/uploads', '/api/tickets/all']) {
  app.get(path, auth.authenticateToken, (req, res) => res.json({ success: true }));
}
const employeeId = '12345678-1234-1234-1234-123456789abc';
const admin = { id: 'admin', role: 'admin' };
const employee = { id: employeeId, role: 'employee', page_permissions: [] };
const reset = (...data) => { calls = []; results = data.map(data => ({ data, error: null })); };
let server, base;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => new Promise(resolve => server.close(resolve)));
const token = jwt.sign({ userId: employeeId }, process.env.JWT_SECRET);
async function request(path, method = 'GET', body, authenticated = true) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
}
test('employee creation hashes password, fixes role, and defaults to no access', async () => {
  reset(admin, { ...employee, name: 'Alex' });
  const response = await request('/api/admin/employees', 'POST', { name: ' Alex ', email: 'ALEX@example.com', password: 'password123' });
  assert.equal(response.status, 201);
  const payload = calls[1].operations.find(op => op[0] === 'insert')[1];
  assert.equal(payload.role, 'employee'); assert.equal(payload.email, 'alex@example.com');
  assert.deepEqual(payload.page_permissions, []);
  assert.ok(await bcrypt.compare('password123', payload.password_hash));
  assert.ok(!JSON.stringify(response.body).includes('password'));
});
test('employee management rejects regular users, employees with all permissions, and unauthenticated requests', async () => {
  for (const user of [{ role: 'user' }, { ...employee, page_permissions: PAGE_KEYS }]) {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      reset(user);
      const response = await request('/api/admin/employees' + (['PATCH', 'DELETE'].includes(method) ? '/' + employeeId : ''), method, method === 'POST' || method === 'PATCH' ? { name: 'Test' } : undefined);
      assert.equal(response.status, 403); assert.equal(calls.length, 1);
    }
  }
  reset(); assert.equal((await request('/api/admin/employees', 'GET', undefined, false)).status, 401);
});
test('invalid passwords, permissions, and role escalation are rejected before writing', async () => {
  for (const change of [{ password: 'short' }, { password: '😀'.repeat(20) }, { page_permissions: ['employees'] }, { page_permissions: 'users' }, { role: 'admin' }]) {
    reset(admin);
    assert.equal((await request('/api/admin/employees', 'POST', { name: 'Alex', email: 'a@example.com', password: 'password123', ...change })).status, 400);
    assert.equal(calls.length, 1);
  }
});
test('editing permissions does not change password and cannot target another role', async () => {
  reset(admin, employee);
  assert.equal((await request('/api/admin/employees/' + employeeId, 'PATCH', { page_permissions: [] })).status, 200);
  assert.deepEqual(calls[1].operations.find(op => op[0] === 'update')[1], { page_permissions: [] });
  assert.ok(calls[1].operations.some(op => op[0] === 'eq' && op[1] === 'role' && op[2] === 'employee'));
  reset(admin, null);
  assert.equal((await request('/api/admin/employees/' + employeeId, 'DELETE')).status, 404);
  assert.ok(calls[1].operations.some(op => op[0] === 'eq' && op[1] === 'role' && op[2] === 'employee'));
});
test('all nine pages require their permission, and revocation applies to the same JWT', async () => {
  const paths = ['/api/customers', '/api/shipping/rate-calculator/saved', '/api/shipping/order', '/api/admin/users', '/api/notifications', '/api/shipping/orders', '/api/kyc/requests', '/api/billing/uploads', '/api/tickets/all'];
  for (let i = 0; i < paths.length; i++) {
    reset({ ...employee, page_permissions: [PAGE_KEYS[i]] }); assert.equal((await request(paths[i])).status, 200, paths[i]);
    reset(employee); assert.equal((await request(paths[i])).status, 403, paths[i]);
    reset(admin); assert.equal((await request(paths[i])).status, 200, paths[i]);
  }
});
test('employee can log in using the admin-set password and receives permissions', async () => {
  const user = { ...employee, email: 'alex@example.com', password_hash: await bcrypt.hash('password123', 10), page_permissions: ['billing'] };
  reset(user);
  const response = await request('/api/auth/login', 'POST', { email: user.email, password: 'password123' }, false);
  assert.equal(response.status, 200); assert.equal(response.body.user.role, 'employee');
  assert.deepEqual(response.body.user.page_permissions, ['billing']);
  assert.equal(jwt.verify(response.body.token, process.env.JWT_SECRET).userId, employeeId);
  assert.ok(!JSON.stringify(response.body).includes('password_hash'));
  reset(user); assert.equal((await request('/api/auth/login', 'POST', { email: user.email, password: 'incorrect' }, false)).status, 401);
});
test('deleted employee JWT is rejected and catalog has exactly nine pages', async () => {
  reset(null); assert.equal((await request('/api/auth/me')).status, 401);
  reset(admin); const response = await request('/api/admin/employees/pages');
  assert.deepEqual(response.body.pages.map(page => page.key), PAGE_KEYS);
  assert.equal(response.body.pages.length, 9);
});
test('admin can reset an employee password and delete the employee', async () => {
  reset(admin, employee);
  assert.equal((await request('/api/admin/employees/' + employeeId, 'PATCH', { password: 'replacement123' })).status, 200);
  const payload = calls[1].operations.find(op => op[0] === 'update')[1];
  assert.ok(await bcrypt.compare('replacement123', payload.password_hash));
  assert.ok(!('page_permissions' in payload));
  reset(admin, { id: employeeId });
  assert.equal((await request('/api/admin/employees/' + employeeId, 'DELETE')).status, 200);
  assert.ok(calls[1].operations.some(op => op[0] === 'delete'));
});
