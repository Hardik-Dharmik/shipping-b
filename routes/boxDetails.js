const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');

const BOX_CODE_PREFIX = 'PK-';
const BOX_CODE_DIGITS = 6;

const generateBoxDetailCode = () => {
  const numericPart = String(
    Math.floor(Math.random() * (10 ** BOX_CODE_DIGITS))
  ).padStart(BOX_CODE_DIGITS, '0');

  return `${BOX_CODE_PREFIX}${numericPart}`;
};

const isDuplicateKeyError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('duplicate key') || message.includes('unique');
};

const normalizeBoxDetailCode = (value) => String(value || '').trim().toUpperCase();

router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { details } = req.body;

    if (details === undefined || details === null) {
      return res.status(400).json({
        success: false,
        error: 'details is required'
      });
    }

    const maxAttempts = 10;
    let inserted = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const boxDetailCode = generateBoxDetailCode();

      const { data, error } = await supabaseAdmin
        .from('box_details')
        .insert({
          user_id: userId,
          box_detail_code: boxDetailCode,
          details
        })
        .select('user_id, box_detail_code, details, created_at')
        .single();

      if (!error) {
        inserted = data;
        break;
      }

      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }

    if (!inserted) {
      return res.status(500).json({
        success: false,
        error: 'Unable to generate unique box detail code. Please retry.'
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Box details saved successfully',
      data: inserted
    });
  } catch (error) {
    console.error('Save box details error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const search = normalizeBoxDetailCode(req.query.search);
    const sortOrder = String(req.query.sortOrder || 'desc').trim().toLowerCase();
    const parsePositiveInteger = (value, fallback) => {
      if (value === undefined) return fallback;
      if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return NaN;

      const parsed = Number.parseInt(value, 10);
      return Number.isInteger(parsed) ? parsed : NaN;
    };

    const page = parsePositiveInteger(req.query.page, 1);
    const limit = parsePositiveInteger(req.query.limit, 10);

    if (!Number.isInteger(page) || !Number.isInteger(limit) || page < 1 || limit < 1) {
      return res.status(400).json({
        success: false,
        error: 'page and limit must be positive integers'
      });
    }

    if (!['asc', 'desc'].includes(sortOrder)) {
      return res.status(400).json({
        success: false,
        error: 'sortOrder must be either asc or desc'
      });
    }

    const safeLimit = Math.min(limit, 100);
    const from = (page - 1) * safeLimit;
    const to = from + safeLimit - 1;

    let query = supabaseAdmin
      .from('box_details')
      .select('user_id, box_detail_code, details, created_at', { count: 'exact' })
      .eq('user_id', userId);

    if (search) {
      const escapedSearch = search.replace(/[%_,]/g, '\\$&');
      query = query.ilike('box_detail_code', `%${escapedSearch}%`);
    }

    const { data, count, error } = await query
      .order('created_at', { ascending: sortOrder === 'asc' })
      .range(from, to);

    if (error) {
      throw error;
    }

    const total = Number.isFinite(count) ? count : 0;
    const totalPages = total === 0 ? 0 : Math.ceil(total / safeLimit);

    return res.json({
      success: true,
      data,
      pagination: {
        page,
        limit: safeLimit,
        search,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    });
  } catch (error) {
    console.error('Get box details list error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

router.get('/:code', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const code = normalizeBoxDetailCode(req.params.code);

    if (!new RegExp(`^${BOX_CODE_PREFIX}[0-9]{${BOX_CODE_DIGITS}}$`).test(code)) {
      return res.status(400).json({
        success: false,
        error: `Code must be in ${BOX_CODE_PREFIX}XXXXXX format`
      });
    }

    const { data, error } = await supabaseAdmin
      .from('box_details')
      .select('user_id, box_detail_code, details, created_at')
      .eq('user_id', userId)
      .eq('box_detail_code', code)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'Box details not found'
      });
    }

    return res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Get box details by code error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

module.exports = router;
