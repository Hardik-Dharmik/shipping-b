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

const parseJsonField = (value, fallback, errorMessage = 'Invalid JSON in request body') => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(errorMessage);
  }
};

const generateAWB = () => `AWB-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

const getAddressValue = (address, keys) => {
  for (const key of keys) {
    const value = address?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return null;
};

const addressLocation = (address, label) => {
  const country = getAddressValue(address, ['country', 'countryName', 'countryCode', 'country_code']);
  const pincode = getAddressValue(address, ['pincode', 'pinCode', 'postalCode', 'postal_code', 'zipCode', 'zip']);
  if (!country || !pincode) {
    throw new Error(`${label} address must include country and pincode`);
  }
  return { country, pincode };
};

const createOrderFromSubmittedForm = async (form, pickupAddress, destinationAddress) => {
  const draft = form.order_data;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('This order link has no saved order details');
  }

  const pickup = addressLocation(pickupAddress, 'Pickup');
  const destination = addressLocation(destinationAddress, 'Destination');
  const boxes = Array.isArray(draft.boxes) ? draft.boxes : [];
  const actualWeight = Number(draft.actualWeight);
  if (!Number.isFinite(actualWeight) || actualWeight <= 0 || boxes.length === 0) {
    throw new Error('The saved order details are incomplete (actualWeight and boxes are required)');
  }

  const carrier = draft.carrier && typeof draft.carrier === 'object'
    ? draft.carrier
    : { name: 'Manual' };
  const awbNumber = generateAWB();
  const orderData = {
    ...draft,
    orderId: `ORD-${Date.now()}`,
    user: { id: form.user_id },
    pickup: { country: pickup.country, pincode: pickup.pincode },
    destination: { country: destination.country, pincode: destination.pincode },
    addresses: { pickup: pickupAddress, destination: destinationAddress },
    products: Array.isArray(draft.products) ? draft.products : [],
    packages: Array.isArray(draft.packages) ? draft.packages : [],
    awb_number: awbNumber,
    status: 'CREATED',
    createdAt: new Date().toISOString(),
    createdFromAddressFormId: form.id
  };

  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .insert({
      user_id: form.user_id,
      awb_number: awbNumber,
      order_data: orderData,
      carrier,
      status: 'CREATED'
    })
    .select()
    .single();

  if (error) throw error;
  return order;
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

// Create an order-link from Create Order. The submitted data intentionally
// excludes the two addresses; those are collected from the recipient later.
router.post('/address-forms/order-link', authenticateToken, async (req, res) => {
  try {
    const orderData = parseJsonField(req.body?.order ?? req.body?.orderData, null);
    if (!orderData || typeof orderData !== 'object' || Array.isArray(orderData)) {
      return res.status(400).json({ success: false, error: 'order (or orderData) must be an object' });
    }
    if (orderData.pickupAddress || orderData.sourceAddress || orderData.destinationAddress || orderData.pickupCountry || orderData.sourceCountry || orderData.destinationCountry) {
      return res.status(400).json({
        success: false,
        error: 'Order-link drafts must not include pickup or destination details'
      });
    }
    if (!Number.isFinite(Number(orderData.actualWeight)) || Number(orderData.actualWeight) <= 0) {
      return res.status(400).json({ success: false, error: 'actualWeight must be a positive number' });
    }
    if (!Array.isArray(orderData.boxes) || orderData.boxes.length === 0) {
      return res.status(400).json({ success: false, error: 'boxes must be a non-empty array' });
    }

    let inserted = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const { data, error } = await supabaseAdmin
        .from('order_address_forms')
        .insert({ user_id: req.user.id, code: generate6DigitCode(), form_type: 'order', order_data: orderData })
        .select('*')
        .single();
      if (!error) {
        inserted = data;
        break;
      }
      if (!isDuplicateKeyError(error)) throw error;
    }
    if (!inserted) throw new Error('Unable to generate a unique 6 digit code. Please retry.');

    const frontendBase = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
    return res.status(201).json({
      success: true,
      message: 'Order address link generated',
      data: { ...inserted, public_link: `${frontendBase}/address-form/${inserted.code}` }
    });
  } catch (error) {
    console.error('Create order address link error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
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
      .select('id, code, form_type, status, is_submitted, expires_at, created_at, order_data')
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

    const responseData = { ...data };
    // Do not expose a customer's internal order draft to anyone who has the link.
    delete responseData.order_data;
    return res.json({
      success: true,
      data: responseData
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
    const pickupAddress = parseJsonField(req.body?.pickupAddress ?? req.body?.sourceAddress, null);
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

    if (form.form_type === 'order') {
      // Claim the form before creating its order so a repeated click cannot issue
      // two AWBs. A claimed form is also protected by the existing submitted check.
      const { data: claimed, error: claimError } = await supabaseAdmin
        .from('order_address_forms')
        .update({ is_submitted: true, submitted_at: new Date().toISOString(), pickup_address: pickupAddress, destination_address: destinationAddress })
        .eq('id', form.id)
        .eq('is_submitted', false)
        .select('*')
        .maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) return res.status(409).json({ success: false, error: 'Form has already been submitted' });

      try {
        const order = await createOrderFromSubmittedForm(claimed, pickupAddress, destinationAddress);
        const { data: completed, error: completionError } = await supabaseAdmin
          .from('order_address_forms')
          .update({ status: 'ordered', order_id: order.id, awb_number: order.awb_number })
          .eq('id', claimed.id)
          .select('*')
          .single();
        if (completionError) throw completionError;
        return res.status(201).json({
          success: true,
          message: 'Order created successfully',
          data: { form: completed, order, awb_number: order.awb_number }
        });
      } catch (error) {
        // Let the recipient retry when order creation failed after the claim.
        await supabaseAdmin.from('order_address_forms').update({ is_submitted: false, submitted_at: null }).eq('id', claimed.id).eq('status', 'open');
        throw error;
      }
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

    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    const fromDate = String(req.query.fromDate || '').trim();
    const toDate = String(req.query.toDate || '').trim();
    const sortBy = String(req.query.sortBy || 'created_at').trim();
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

    const isValidDate = (value) => !value || !Number.isNaN(Date.parse(value));

    if (!isValidDate(fromDate) || !isValidDate(toDate)) {
      return res.status(400).json({
        success: false,
        error: 'fromDate and toDate must be valid dates'
      });
    }

    const allowedSortFields = new Set(['created_at', 'status']);
    const allowedSortOrders = new Set(['asc', 'desc']);

    if (!allowedSortFields.has(sortBy)) {
      return res.status(400).json({
        success: false,
        error: 'sortBy must be one of: created_at, status'
      });
    }

    if (!allowedSortOrders.has(sortOrder)) {
      return res.status(400).json({
        success: false,
        error: 'sortOrder must be either asc or desc'
      });
    }

    const safeLimit = Math.min(limit, 100);
    const from = (page - 1) * safeLimit;
    const to = from + safeLimit - 1;

    let query = supabaseAdmin
      .from('order_address_forms')
      .select('*')
      .eq('user_id', userId)
      .eq('is_submitted', true);

    if (search) {
      const escapedSearch = search.replace(/[%_,]/g, '\\$&');
      query = query.or(
        `code.ilike.%${escapedSearch}%`
      );
    }

    if (status) {
      query = query.ilike('status', status);
    }

    if (fromDate) {
      query = query.gte('created_at', new Date(fromDate).toISOString());
    }

    if (toDate) {
      const endOfDay = new Date(toDate);
      endOfDay.setHours(23, 59, 59, 999);
      query = query.lte('created_at', endOfDay.toISOString());
    }

    const { data, count, error } = await query
    .order(sortBy, { ascending: sortOrder === 'asc' })
    .range(from, to);

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    const total = Number.isFinite(count) ? count : 0;
    const totalPages = total === 0 ? 0 : Math.ceil(total / safeLimit);

    res.json({
      success: true,
      data,
      pagination: {
        page,
        limit: safeLimit,
        search,
        filters: {
          status,
          fromDate,
          toDate
        },
        sorting: {
          sortBy,
          sortOrder
        },
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
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

