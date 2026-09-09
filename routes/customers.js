const express = require('express');
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');
const { CUSTOMER_FIELDS, isCustomerId } = require('../utils/customers');
const router = express.Router();
router.use(authenticateToken);

router.post('/', async (req, res) => {
  try {
    const { companyName, email, phoneNumber } = req.body || {};
    if (typeof companyName !== 'string' || !companyName.trim() || companyName.trim().length > 200) {
      return res.status(400).json({ success: false, error: 'companyName is required and must be at most 200 characters' });
    }
    if (typeof email !== 'string' || email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ success: false, error: 'A valid email is required' });
    }
    if (typeof phoneNumber !== 'string' || phoneNumber.trim().length > 32 ||
        !/^\+?[0-9 ()-]+$/.test(phoneNumber.trim()) || phoneNumber.replace(/\D/g, '').length < 7 || phoneNumber.replace(/\D/g, '').length > 15) {
      return res.status(400).json({ success: false, error: 'phoneNumber must contain 7 to 15 digits with optional +, spaces, parentheses or hyphens' });
    }
    const { data, error } = await supabaseAdmin.from('customers').insert({
      user_id: req.user.id,
      company_name: companyName.trim().replace(/\s+/g, ' '),
      email: email.trim().toLowerCase(),
      phone_number: phoneNumber.trim()
    }).select(CUSTOMER_FIELDS).single();
    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('Create customer error:', error);
    return res.status(500).json({ success: false, error: 'Unable to create customer' });
  }
});

const listCustomers = (suggestions) => async (req, res) => {
  try {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const limit = req.query.limit === undefined ? (suggestions ? 10 : 20) : Number(req.query.limit);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1) {
      return res.status(400).json({ success: false, error: 'page and limit must be positive integers' });
    }
    if (req.query.query !== undefined && (typeof req.query.query !== 'string' || req.query.query.length > 200)) {
      return res.status(400).json({ success: false, error: 'query must be a string of at most 200 characters' });
    }
    const limitValue = Math.min(limit, suggestions ? 20 : 100);
    const offset = suggestions ? 0 : (page - 1) * limitValue;
    if (!Number.isSafeInteger(offset + limitValue)) {
      return res.status(400).json({ success: false, error: 'page is too large' });
    }
    let query = supabaseAdmin.from('customers').select(CUSTOMER_FIELDS, { count: 'exact' })
      .order('company_name').order('id');
    const search = (req.query.query || '').trim();
    if (search) {
      // Quote PostgREST values so punctuation cannot inject additional filters.
      const pattern = JSON.stringify(`%${search.replace(/[\\%_*]/g, '\\$&')}%`);
      query = query.or(`company_name.ilike.${pattern},id.ilike.${pattern},email.ilike.${pattern},phone_number.ilike.${pattern}`);
    }
    const { data, count, error } = await query.range(offset, offset + limitValue - 1);
    if (error) throw error;
    return res.json({ success: true, data: data || [],
      ...(!suggestions ? { pagination: { page, limit: limitValue, total: count || 0, totalPages: Math.ceil((count || 0) / limitValue) } } : {}) });
  } catch (error) {
    console.error('List customers error:', error);
    return res.status(500).json({ success: false, error: 'Unable to load customers' });
  }
};

router.get('/', listCustomers(false));
router.get('/suggestions', listCustomers(true));
router.get('/:id', async (req, res) => {
  if (!isCustomerId(req.params.id)) return res.status(400).json({ success: false, error: 'Customer id must be a 6 digit string' });
  try {
    const { data, error } = await supabaseAdmin.from('customers').select(CUSTOMER_FIELDS)
      .eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Customer not found' });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Unable to load customer' });
  }
});

module.exports = router;
