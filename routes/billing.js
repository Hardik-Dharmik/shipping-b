const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only images, PDFs, and documents are allowed!'));
  }
});

const sanitizeFileName = (name) => {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
};

const normalizeBillingType = (value) => {
  if (!value) return null;
  const raw = String(value).trim().toUpperCase();

  if (raw === 'BOE') return 'BOE';
  if (raw === 'INVOICE') return 'INVOICE';
  if (raw === 'D/O' || raw === 'DO' || raw === 'D-O' || raw === 'D O') return 'DO';

  return null;
};

const { requireAdminAccess } = require('../middleware/adminAccess');
const { hasPageAccess } = require('../utils/permissions');
const isAdmin = requireAdminAccess('billing');

router.post('/upload', isAdmin, upload.single('file'), async (req, res) => {
  try {
    const { awb_number, type } = req.body;
    const file = req.file;

    if (!awb_number || !type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: awb_number, type'
      });
    }

    const normalizedType = normalizeBillingType(type);
    if (!normalizedType) {
      return res.status(400).json({
        success: false,
        error: 'Invalid type. Allowed: BOE, D/O, INVOICE'
      });
    }

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'File is required'
      });
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .select('user_id')
      .eq('awb_number', awb_number)
      .single();

    if (orderError || !order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found for this AWB number'
      });
    }

    const safeName = sanitizeFileName(file.originalname || 'document');
    const filePath = `${awb_number}/${normalizedType}/${Date.now()}_${safeName}`;

    const { error } = await supabaseAdmin.storage
      .from('billing')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype
      });

    if (error) throw error;

    const { data } = supabaseAdmin.storage
      .from('billing')
      .getPublicUrl(filePath);

    const uploadedBy = req.user?.id || null;

    const { data: billingRecord, error: insertError } = await supabaseAdmin
      .from('billing_uploads')
      .insert({
        awb_number,
        billing_type: normalizedType,
        user_id: order.user_id,
        file_url: data.publicUrl,
        file_path: filePath,
        file_name: file.originalname,
        file_type: file.mimetype,
        uploaded_by: uploadedBy
      })
      .select()
      .single();

    if (insertError) throw insertError;

    await supabaseAdmin
      .from('notifications')
      .insert({
        user_id: order.user_id,
        type: 'billing_upload',
        title: 'Billing document uploaded',
        body: `${normalizedType} document uploaded for AWB ${awb_number}.`,
        data: {
          awb_number,
          billing_type: normalizedType,
          file_url: data.publicUrl
        }
      });

    return res.status(201).json({
      success: true,
      awb_number,
      type: normalizedType,
      file_path: filePath,
      file_url: data.publicUrl,
      file_name: file.originalname,
      file_type: file.mimetype,
      record: billingRecord
    });
  } catch (error) {
    console.error('Billing upload error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

router.get('/uploads', authenticateToken, async (req, res) => {
  try {
    const { awb_number, type } = req.query;
    const isAdminUser = hasPageAccess(req.user, 'billing');

    let query = supabaseAdmin
      .from('billing_uploads')
      .select('*')
      .order('created_at', { ascending: false });

    if (!isAdminUser) {
      query = query.eq('user_id', req.user.id);
    }

    if (awb_number) {
      query = query.eq('awb_number', awb_number);
    }

    if (type) {
      const normalizedType = normalizeBillingType(type);
      if (!normalizedType) {
        return res.status(400).json({
          success: false,
          error: 'Invalid type. Allowed: BOE, D/O, INVOICE'
        });
      }
      query = query.eq('billing_type', normalizedType);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Billing list error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

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
    console.error('Billing router error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error'
    });
  }
  next();
});

module.exports = router;
