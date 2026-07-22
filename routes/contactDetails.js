const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');

const normalizeWhitespace = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const normalizeCompanyName = (value) => normalizeWhitespace(value).toLowerCase();

const toContactResponse = (item) => ({
  id: item.id,
  companyName: item.company_name,
  details: item.details,
  createdAt: item.created_at,
  updatedAt: item.updated_at
});

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

    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      return res.status(400).json({
        success: false,
        error: 'details must be an object'
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
      details: {
        ...details,
        company: details.company || details.companyName || companyName
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Contact details saved successfully',
      data: toContactResponse(saved)
    });
  } catch (error) {
    console.error('Save contact details error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// List all saved contacts for the signed-in user.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const query = normalizeWhitespace(req.query.query);

    let dbQuery = supabaseAdmin
      .from('contact_details')
      .select('id, company_name, details, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (query) {
      const escapedQuery = query.replace(/[%_,]/g, '\\$&');
      dbQuery = dbQuery.ilike('company_name', `%${escapedQuery}%`);
    }

    const { data, error } = await dbQuery;
    if (error) throw error;

    return res.json({ success: true, data: (data || []).map(toContactResponse) });
  } catch (error) {
    console.error('List contact details error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

router.get('/suggestions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const query = normalizeWhitespace(req.query.query);
    const limit = parsePositiveInteger(req.query.limit, 10);

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
      data: (data || []).map(toContactResponse)
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
      data: toContactResponse(data)
    });
  } catch (error) {
    console.error('Get contact details error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = String(req.params.id || '').trim();
    const details = req.body?.details;
    const companyName = extractCompanyName(req.body);

    if (!id) return res.status(400).json({ success: false, error: 'id is required' });
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      return res.status(400).json({ success: false, error: 'details must be an object' });
    }
    if (!companyName) return res.status(400).json({ success: false, error: 'company name is required' });
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('contact_details')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (existingError || !existing) {
      return res.status(404).json({ success: false, error: 'Contact details not found' });
    }

    const { data, error } = await supabaseAdmin
      .from('contact_details')
      .update({
        company_name: companyName,
        normalized_company_name: normalizeCompanyName(companyName),
        details: { ...details, company: details.company || details.companyName || companyName },
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select('id, company_name, details, created_at, updated_at')
      .single();

    if (error) throw error;
    return res.json({ success: true, message: 'Contact details updated successfully', data: toContactResponse(data) });
  } catch (error) {
    console.error('Update contact details error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const { data, error } = await supabaseAdmin
      .from('contact_details')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Contact details not found' });

    return res.json({ success: true, message: 'Contact details deleted successfully' });
  } catch (error) {
    console.error('Delete contact details error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

module.exports = router;
module.exports.saveContactDetails = saveContactDetails;
module.exports.extractCompanyName = extractCompanyName;
