const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');

const DEFAULT_CONTACT_TYPE = 'pickup';
const ALLOWED_CONTACT_TYPES = new Set(['pickup', 'delivery']);

const normalizeWhitespace = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const normalizeCompanyName = (value) => normalizeWhitespace(value).toLowerCase();

const normalizeContactType = (value) => {
  const normalized = String(value || DEFAULT_CONTACT_TYPE).trim().toLowerCase();
  return ALLOWED_CONTACT_TYPES.has(normalized) ? normalized : null;
};

const parsePositiveInteger = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return NaN;

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : NaN;
};

const extractCompanyName = (payload = {}) => {
  const directValue = normalizeWhitespace(payload.companyName || payload.company);
  if (directValue) return directValue;

  if (payload.details && typeof payload.details === 'object') {
    const nestedValue = normalizeWhitespace(
      payload.details.companyName ||
      payload.details.company ||
      payload.details.company_name
    );

    if (nestedValue) return nestedValue;
  }

  return '';
};

const saveContactDetails = async ({
  userId,
  companyName,
  contactType = DEFAULT_CONTACT_TYPE,
  details
}) => {
  const normalizedCompanyName = normalizeCompanyName(companyName);
  const now = new Date().toISOString();

  const payload = {
    user_id: userId,
    company_name: companyName,
    normalized_company_name: normalizedCompanyName,
    details,
    updated_at: now
  };

  const { data, error } = await supabaseAdmin
    .from('contact_details')
    .upsert(payload, {
      onConflict: 'user_id,normalized_company_name'
    })
    .select('id, user_id,  company_name, details, created_at, updated_at')
    .single();

  if (error) {
    throw error;
  }

  return data;
};

router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const details = req.body?.details;
    const companyName = extractCompanyName(req.body);
    const contactType = normalizeContactType(req.body?.contactType);

    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      return res.status(400).json({
        success: false,
        error: 'details must be an object'
      });
    }

    if (!contactType) {
      return res.status(400).json({
        success: false,
        error: 'contactType must be either pickup or delivery'
      });
    }

    if (!companyName) {
      return res.status(400).json({
        success: false,
        error: 'company name is required'
      });
    }

    const saved = await saveContactDetails({
      userId,
      companyName,
      contactType,
      details: {
        ...details,
        company: details.company || details.companyName || companyName
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Contact details saved successfully',
      data: saved
    });
  } catch (error) {
    console.error('Save contact details error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

router.get('/suggestions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const query = normalizeWhitespace(req.query.query);
    const contactType = normalizeContactType(req.query.contactType || DEFAULT_CONTACT_TYPE);
    const limit = parsePositiveInteger(req.query.limit, 10);

    if (!contactType) {
      return res.status(400).json({
        success: false,
        error: 'contactType must be either pickup or delivery'
      });
    }

    if (!Number.isInteger(limit) || limit < 1) {
      return res.status(400).json({
        success: false,
        error: 'limit must be a positive integer'
      });
    }

    const safeLimit = Math.min(limit, 20);
    let dbQuery = supabaseAdmin
      .from('contact_details')
      .select('id, company_name, details, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(safeLimit);

    if (query) {
      const escapedQuery = query.replace(/[%_,]/g, '\\$&');
      dbQuery = dbQuery.ilike('company_name', `%${escapedQuery}%`);
    }

    const { data, error } = await dbQuery;

    if (error) {
      throw error;
    }

    return res.json({
      success: true,
      data: (data || []).map((item) => ({
        id: item.id,
        companyName: item.company_name,
        contactType: item.contact_type,
        details: item.details,
        createdAt: item.created_at,
        updatedAt: item.updated_at
      }))
    });
  } catch (error) {
    console.error('Get contact suggestions error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = String(req.params.id || '').trim();

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'id is required'
      });
    }

    const { data, error } = await supabaseAdmin
      .from('contact_details')
      .select('id, company_name, details, created_at, updated_at')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'Contact details not found'
      });
    }

    return res.json({
      success: true,
      data: {
        id: data.id,
        companyName: data.company_name,
        details: data.details,
        createdAt: data.created_at,
        updatedAt: data.updated_at
      }
    });
  } catch (error) {
    console.error('Get contact details error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

module.exports = router;
module.exports.saveContactDetails = saveContactDetails;
module.exports.extractCompanyName = extractCompanyName;
module.exports.normalizeContactType = normalizeContactType;
