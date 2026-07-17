const express = require('express');
const multer = require('multer');
const path = require('path');
const { authenticateToken } = require('./auth');
const { isAdmin } = require('./admin');
const { supabaseAdmin } = require('../supabase');

const router = express.Router();

const KYC_STATUS = {
  NOT_STARTED: 'not_started',
  PENDING: 'pending',
  COMPLETED: 'completed'
};

const KYC_DOCUMENT_FIELDS = {
  credit_application_form: 'credit_application_form_url',
  trade_licence: 'trade_licence_url',
  trn_licence: 'trn_licence_url'
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
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

const sanitizeFileName = (name) => name.replace(/[^a-zA-Z0-9._-]/g, '_');

const buildKycPayload = (user) => ({
  kyc_status: user.kyc_status,
  documents: {
    credit_application_form_url: user.credit_application_form_url,
    trade_licence_url: user.trade_licence_url,
    trn_licence_url: user.trn_licence_url
  }
});

const uploadToStorage = async (userId, fieldName, file) => {
  const safeName = sanitizeFileName(file.originalname || 'document');
  const extension = path.extname(safeName);
  const storagePath = `${userId}/${fieldName}/${Date.now()}${extension}`;

  const { error } = await supabaseAdmin.storage
    .from('kyc-documents')
    .upload(storagePath, file.buffer, {
      contentType: file.mimetype,
      upsert: true
    });

  if (error) {
    throw error;
  }

  const { data } = supabaseAdmin.storage
    .from('kyc-documents')
    .getPublicUrl(storagePath);

  return data.publicUrl;
};

router.post(
  '/request',
  authenticateToken,
  upload.fields([
    { name: 'credit_application_form', maxCount: 1 },
    { name: 'trade_licence', maxCount: 1 },
    { name: 'trn_licence', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const files = req.files || {};
      const creditApplicationForm = files.credit_application_form?.[0];
      const tradeLicence = files.trade_licence?.[0];
      const trnLicence = files.trn_licence?.[0];

      if (!creditApplicationForm || !tradeLicence || !trnLicence) {
        return res.status(400).json({
          success: false,
          error: 'All three documents are required: credit_application_form, trade_licence, trn_licence'
        });
      }

      const uploadedUrls = {};

      for (const [fieldName, columnName] of Object.entries(KYC_DOCUMENT_FIELDS)) {
        const file = files[fieldName]?.[0];
        uploadedUrls[columnName] = await uploadToStorage(req.user.id, fieldName, file);
      }

      const updatePayload = {
        ...uploadedUrls,
        kyc_status: KYC_STATUS.PENDING,
        updated_at: new Date().toISOString()
      };

      const { data, error } = await supabaseAdmin
        .from('users')
        .update(updatePayload)
        .eq('id', req.user.id)
        .select('id, name, email, company_name, kyc_status, credit_application_form_url, trade_licence_url, trn_licence_url, updated_at')
        .single();

      if (error) {
        throw error;
      }

      return res.status(201).json({
        success: true,
        message: 'KYC request submitted successfully',
        user: data
      });
    } catch (error) {
      console.error('KYC request error:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }
);

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, name, email, company_name, kyc_status, credit_application_form_url, trade_licence_url, trn_licence_url, updated_at')
      .eq('id', req.user.id)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    return res.json({
      success: true,
      user: data,
      kyc: buildKycPayload(data)
    });
  } catch (error) {
    console.error('KYC fetch error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

router.get('/requests', isAdmin, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();

    let query = supabaseAdmin
      .from('users')
      .select('id, name, email, company_name, approval_status, kyc_status, credit_application_form_url, trade_licence_url, trn_licence_url, created_at, updated_at')
      .neq('kyc_status', KYC_STATUS.NOT_STARTED)
      .order('updated_at', { ascending: false });

    if (status) {
      if (!Object.values(KYC_STATUS).includes(status)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid status. Allowed: not_started, pending, completed'
        });
      }
      query = query.eq('kyc_status', status);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return res.json({
      success: true,
      count: data.length,
      requests: data
    });
  } catch (error) {
    console.error('KYC requests list error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

router.patch('/users/:id/status', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status:kyc_status } = req.body;

    if (![KYC_STATUS.PENDING, KYC_STATUS.COMPLETED].includes(kyc_status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid kyc_status. Allowed: pending, completed'
      });
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .update({
        kyc_status,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select('id, name, email, company_name, kyc_status, credit_application_form_url, trade_licence_url, trn_licence_url, updated_at')
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    return res.json({
      success: true,
      message: 'KYC status updated successfully',
      user: data
    });
  } catch (error) {
    console.error('KYC status update error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

router.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    return res.status(400).json({
      success: false,
      error: err.message,
      code: err.code,
      field: err.field
    });
  }

  if (err) {
    return res.status(400).json({
      success: false,
      error: err.message || 'Internal server error'
    });
  }

  next();
});

module.exports = router;
