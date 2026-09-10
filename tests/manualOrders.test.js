const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
let inserted, uploads, removed, insertError, failUpload, customerExists;
const bucket = {
  async upload(path) { if (uploads.length === failUpload) return { error: new Error('Storage failed') }; uploads.push(path); return {}; },
  getPublicUrl(path) { return { data: { publicUrl: `https://files.example/${path}` } }; },
  async remove(paths) { removed.push(...paths); return {}; }
};
const db = { storage: { from: () => bucket }, from(table) {
  const query = { select() { return this; }, eq() { return this; }, insert(row) { inserted = row; return this; },
    async maybeSingle() { return { data: customerExists ? { id: '100000' } : null }; },
    async single() { return { data: inserted, error: insertError }; }
  };
  assert.ok(['customers', 'orders'].includes(table));
  return query;
} };
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub('../supabase', { supabaseAdmin: db });
stub('../routes/auth', { authenticateToken(req, res, next) { if (!req.headers.authorization) return res.sendStatus(401); req.user = { id: 'owner' }; next(); } });
const app = express();
app.use(require('../routes/manualOrders'));
let server, base;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => new Promise(resolve => server.close(resolve)));
function reset() { inserted = null; uploads = []; removed = []; insertError = null; failUpload = -1; customerExists = true; }
function form() {
  const body = new FormData();
  body.set('awbNumber', ' AWB/123 '); body.set('agentName', ' Agent Name '); body.set('customerId', '100000');
  body.set('awbFile', new Blob(['%PDF-1.7\n'], { type: 'application/pdf' }), 'awb.pdf');
  for (const section of ['pickup', 'destination', 'packaging']) body.set(`${section}Screenshot`, new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'screen.png');
  body.set('compliance', JSON.stringify({ requireBOE: true, insurance: false }));
  return body;
}
async function send(body, auth = true) { const response = await fetch(`${base}/order/manual`, { method: 'POST', headers: auth ? { authorization: 'Bearer test' } : {}, body }); return response; }
test('manual orders require authentication', async () => { reset(); assert.equal((await send(form(), false)).status, 401); assert.equal(uploads.length, 0); });
test('stores a manual order with customer, screenshots, named documents and compliance', async () => {
  reset(); const body = form(); body.append('otherDocuments', new Blob(['%PDF-1.7'], { type: 'application/pdf' }), 'invoice.pdf'); body.set('documentNames', '[" Invoice "]');
  const response = await send(body); assert.equal(response.status, 201);
  assert.equal(inserted.user_id, 'owner'); assert.equal(inserted.customer_id, '100000'); assert.equal(inserted.awb_number, 'AWB/123');
  assert.deepEqual(inserted.carrier, {}); assert.equal(inserted.order_data.orderType, 'manual');
  assert.equal(inserted.order_data.agentName, 'Agent Name'); assert.equal(inserted.order_data.otherDocuments[0].documentName, 'Invoice');
  assert.equal(inserted.order_data.compliance.requireBOE, true); assert.equal(Object.keys(inserted.order_data.screenshots).length, 3);
  assert.equal(uploads.length, 5); assert.equal(new Set(uploads).size, 5); assert.ok(uploads.every(path => !path.includes('AWB/123')));
});
test('rejects missing mandatory fields, invalid files and mismatched document names before uploads', async () => {
  for (const field of ['awbNumber', 'agentName', 'customerId', 'awbFile', 'pickupScreenshot', 'destinationScreenshot', 'packagingScreenshot']) {
    reset(); const body = form(); body.delete(field); assert.equal((await send(body)).status, 400, field); assert.equal(uploads.length, 0);
  }
  for (const [field, value] of [['documentNames', '["Missing file"]'], ['compliance', '{bad'], ['compliance', '{"insurance":"false"}'], ['agentName', '   ']]) {
    reset(); const body = form(); body.set(field, value); assert.equal((await send(body)).status, 400); assert.equal(uploads.length, 0);
  }
  reset(); const body = form(); body.set('awbFile', new Blob(['fake'], { type: 'application/pdf' }), 'awb.pdf'); assert.equal((await send(body)).status, 400); assert.equal(uploads.length, 0);
});
test('rejects unknown customers without uploading', async () => { reset(); customerExists = false; assert.equal((await send(form())).status, 404); assert.equal(uploads.length, 0); });
test('cleans up files on duplicate AWB and storage failure', async () => {
  reset(); insertError = { code: '23505' }; assert.equal((await send(form())).status, 409); assert.deepEqual(removed, uploads);
  reset(); failUpload = 2; assert.equal((await send(form())).status, 500); assert.equal(inserted, null); assert.equal(uploads.length, 2); assert.deepEqual(removed, uploads);
});
test('manual details return the original files without fabricated pricing or pickup lookups', async () => {
  const { getOrderDetails } = require('../utils/orderDetails');
  const order = { order_data: { orderType: 'manual', screenshots: { pickup: { url: 'image.png' } } } };
  assert.deepEqual(await getOrderDetails(order), { order, pickup: null, costBreakdown: null, carrierCostBreakdown: null });
});
