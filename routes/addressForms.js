const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');



const generate6DigitCode = () => {
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
};

const isDuplicateKeyError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('duplicate key') || message.includes('unique');
};


// Multer error logger for this router
router.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    console.error('Multer error:', {
      code: err.code,
      field: err.field,
      message: err.message
    });
    return res.status(400).json({
      success: false,
      error: err.message,
      code: err.code,
      field: err.field
    });
  }
  if (err) {
    console.error('Shipping router error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error'
    });
  }
  next();
});

// Create a shareable address form link
router.post('/address-forms', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const maxAttempts = 10;
    let inserted = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const code = generate6DigitCode();
      const { data, error } = await supabaseAdmin
        .from('order_address_forms')
        .insert({
          user_id: userId,
          code
        })
        .select('*')
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
        error: 'Unable to generate unique 6 digit code. Please retry.'
      });
    }

    const frontendBase = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
    const publicLink = `${frontendBase}/address-form/${inserted.code}`;

    return res.status(201).json({
      success: true,
      message: 'Address form link generated',
      data: {
        ...inserted,
        public_link: publicLink
      }
    });
  } catch (error) {
    console.error('Create address form error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Public: get basic form details by code
router.get('/address-forms/public/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({
        success: false,
        error: 'Code must be a 6 digit number'
      });
    }

    const { data, error } = await supabaseAdmin
      .from('order_address_forms')
      .select('id, code, status, is_submitted, expires_at, created_at')
      .eq('code', code)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'Form not found'
      });
    }

    if (data.is_submitted) {
      return res.status(400).json({
        success: false,
        error: 'Form already submitted'
      });
    }

    if (data.status === 'ordered') {
      return res.status(400).json({
        success: false,
        error: 'Form has already been used for an order'
      });
    }

    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        error: 'Form has expired'
      });
    }

    return res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Get public address form error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Public: submit pickup and destination addresses by code
router.post('/address-forms/public/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const parseJsonField = (value, fallback) => {
      if (value === undefined || value === null || value === '') return fallback;
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch (err) {
        throw new Error('Invalid JSON in request body');
      }
    };

    const pickupAddress = parseJsonField(req.body?.pickupAddress, null);
    const destinationAddress = parseJsonField(req.body?.destinationAddress, null);
    const products = parseJsonField(req.body?.products, []);

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({
        success: false,
        error: 'Code must be a 6 digit number'
      });
    }

    if (!pickupAddress || !destinationAddress) {
      return res.status(400).json({
        success: false,
        error: 'pickupAddress and destinationAddress are required'
      });
    }

    if (!Array.isArray(products)) {
      return res.status(400).json({
        success: false,
        error: 'products must be an array'
      });
    }

    const { data: form, error: findError } = await supabaseAdmin
      .from('order_address_forms')
      .select('*')
      .eq('code', code)
      .single();

    if (findError || !form) {
      return res.status(404).json({
        success: false,
        error: 'Form not found'
      });
    }

    if (form.is_submitted) {
      return res.status(400).json({
        success: false,
        error: 'Form already submitted'
      });
    }

    if (form.status === 'ordered') {
      return res.status(400).json({
        success: false,
        error: 'Form has already been used for an order'
      });
    }

    if (form.expires_at && new Date(form.expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        error: 'Form has expired'
      });
    }

    const { data, error } = await supabaseAdmin
      .from('order_address_forms')
      .update({
        pickup_address: pickupAddress,
        destination_address: destinationAddress,
        products,
        is_submitted: true,
        submitted_at: new Date().toISOString()
      })
      .eq('id', form.id)
      .select('*')
      .single();

    if (error) throw error;

    return res.json({
      success: true,
      message: 'Address form submitted successfully',
      data
    });
  } catch (error) {
    console.error('Submit public address form error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Get submitted address forms for current user
router.get('/address-forms', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabaseAdmin
      .from('order_address_forms')
      .select('*')
      .eq('user_id', userId)
      .eq('is_submitted', true)
      .order('submitted_at', { ascending: false });

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    return res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Get user address forms error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Get one submitted address form for prefill
router.get('/address-forms/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { data, error } = await supabaseAdmin
      .from('order_address_forms')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'Address form not found'
      });
    }

    return res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Get single address form error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});




module.exports = router;

