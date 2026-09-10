const express = require('express');
const bcrypt = require('bcrypt');
const { supabaseAdmin } = require('../supabase');
const { requireAdminAccess } = require('../middleware/adminAccess');
const { ADMIN_PAGES, PAGE_KEYS } = require('../utils/permissions');
const router = express.Router();
const fields = 'id, name, email, company_name, role, page_permissions, created_at, updated_at';
router.use(requireAdminAccess());
router.get('/pages', (req, res) => res.json({ success: true, pages: ADMIN_PAGES }));

function validate(body, creating) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'A JSON object is required';
  const allowed = ['name', 'email', 'password', 'company_name', 'page_permissions'];
  if (Object.keys(body).some(key => !allowed.includes(key))) return 'Unknown employee field';
  if (!creating && !Object.keys(body).length) return 'At least one field is required';
  for (const key of ['name', 'email']) {
    if ((creating || key in body) && (typeof body[key] !== 'string' || !body[key].trim())) return `${key} is required`;
  }
  if ('email' in body && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) return 'Invalid email';
  if ('company_name' in body && typeof body.company_name !== 'string') return 'company_name must be a string';
  if ((creating || 'password' in body) && (typeof body.password !== 'string' || body.password.length < 8 || Buffer.byteLength(body.password, 'utf8') > 72)) return 'Password must be at least 8 characters and at most 72 bytes';
  if ('page_permissions' in body && (!Array.isArray(body.page_permissions) || body.page_permissions.some(page => !PAGE_KEYS.includes(page)))) return 'page_permissions must be an array of valid page keys';
  return null;
}
async function values(body) {
  const data = {};
  for (const key of ['name', 'email', 'company_name']) if (key in body) data[key] = body[key].trim();
  if (data.email) data.email = data.email.toLowerCase();
  if ('page_permissions' in body) data.page_permissions = [...new Set(body.page_permissions)];
  if ('password' in body) data.password_hash = await bcrypt.hash(body.password, 10);
  return data;
}
function failure(res, error) {
  const status = error.code === '23505' ? 409 : error.code === '23503' ? 409 : 500;
  return res.status(status).json({ success: false, error: error.code === '23505' ? 'Email already exists' : error.code === '23503' ? 'Employee has linked records and cannot be deleted' : 'Employee operation failed' });
}
router.param('id', (req, res, next, id) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return res.status(400).json({ success: false, error: 'Invalid employee ID' });
  next();
});
router.get('/', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('users').select(fields).eq('role', 'employee').order('created_at', { ascending: false });
  if (error) return failure(res, error);
  res.json({ success: true, employees: data });
});
router.post('/', async (req, res) => {
  const invalid = validate(req.body, true);
  if (invalid) return res.status(400).json({ success: false, error: invalid });
  const payload = { company_name: '', page_permissions: [], ...await values(req.body), role: 'employee', kyc_required: false };
  const { data, error } = await supabaseAdmin.from('users').insert(payload).select(fields).single();
  if (error) return failure(res, error);
  res.status(201).json({ success: true, employee: data });
});
router.get('/:id', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('users').select(fields).eq('id', req.params.id).eq('role', 'employee').maybeSingle();
  if (error) return failure(res, error);
  if (!data) return res.status(404).json({ success: false, error: 'Employee not found' });
  res.json({ success: true, employee: data });
});
router.patch('/:id', async (req, res) => {
  const invalid = validate(req.body, false);
  if (invalid) return res.status(400).json({ success: false, error: invalid });
  const { data, error } = await supabaseAdmin.from('users').update(await values(req.body)).eq('id', req.params.id).eq('role', 'employee').select(fields).maybeSingle();
  if (error) return failure(res, error);
  if (!data) return res.status(404).json({ success: false, error: 'Employee not found' });
  res.json({ success: true, employee: data });
});
router.delete('/:id', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('users').delete().eq('id', req.params.id).eq('role', 'employee').select('id').maybeSingle();
  if (error) return failure(res, error);
  if (!data) return res.status(404).json({ success: false, error: 'Employee not found' });
  res.json({ success: true, message: 'Employee deleted' });
});
module.exports = router;
