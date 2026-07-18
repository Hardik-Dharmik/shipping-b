const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const multer = require('multer');
const { supabaseAdmin } = require('../supabase');
const upload = require('../middleware/upload');
const path = require('path');
const fs = require('fs');

const ORGANIZATION_TYPES = {
  NEW: 'new',
  EMPLOYEE: 'employee'
};

const normalizeOrganizationName = (value) => String(value || '').trim().toLowerCase();

const safeUnlink = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};

const generateOrganizationCode = async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `ORG-${String(Math.floor(100000 + Math.random() * 900000))}`;
    const { data: existingOrganization, error } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .eq('organization_code', candidate)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!existingOrganization) {
      return candidate;
    }
  }

  throw new Error('Unable to generate a unique organization ID. Please try again.');
};

// Register endpoint
router.post('/',
  upload.single('file'),
  // Error handler for multer
  (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          error: 'File too large. Maximum size is 10MB.'
        });
      }
      return res.status(400).json({
        success: false,
        error: `File upload error: ${err.message}`
      });
    }
    if (err) {
      return res.status(400).json({
        success: false,
        error: err.message
      });
    }
    next();
  },
  async (req, res) => {
    const startTime = Date.now();
    let createdOrganizationId = null;
    let createdOrganizationCode = null;
    let uploadedStoragePath = null;
    let storageUploadCompleted = false;

    console.log('[REGISTER] Registration attempt started', {
      email: req.body.email,
      name: req.body.name,
      company_name: req.body.company_name,
      organization_type: req.body.organization_type,
      timestamp: new Date().toISOString()
    });

    try {
      const { name, email, password } = req.body;
      const company_name = String(req.body.company_name || '').trim();
      const organizationType = String(req.body.organization_type || ORGANIZATION_TYPES.NEW).trim().toLowerCase();
      const organizationName = String(req.body.organization_name || company_name).trim();
      const organizationCodeInput = String(
        req.body.organization_code || req.body.organization_id || req.body.org_id || ''
      ).trim().toUpperCase();
      const file = req.file;
      let resolvedOrganization = null;

      console.log('[REGISTER] Validating input fields');
      // Validate required fields
      if (!name || !email || !password) {
        if (file) {
          safeUnlink(file.path);
          console.log('[REGISTER] Missing required fields - cleaned up file');
        }
        console.warn('[REGISTER] Registration failed - Missing required fields', {
          email: email || 'not provided',
          hasName: !!name,
          hasEmail: !!email,
          hasPassword: !!password,
          organizationType
        });
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: name, email, password'
        });
      }

      if (![ORGANIZATION_TYPES.NEW, ORGANIZATION_TYPES.EMPLOYEE].includes(organizationType)) {
        if (file) {
          safeUnlink(file.path);
        }
        return res.status(400).json({
          success: false,
          error: 'organization_type must be either new or employee'
        });
      }

      if (organizationType === ORGANIZATION_TYPES.NEW && !organizationName) {
        if (file) {
          safeUnlink(file.path);
        }
        return res.status(400).json({
          success: false,
          error: 'organization_name is required for new organization registration'
        });
      }

      if (organizationType === ORGANIZATION_TYPES.EMPLOYEE && !organizationCodeInput) {
        if (file) {
          safeUnlink(file.path);
        }
        return res.status(400).json({
          success: false,
          error: 'organization_code is required for employee registration'
        });
      }

      // Validate file
      if (!file) {
        console.warn('[REGISTER] Registration failed - File not provided', { email });
        return res.status(400).json({
          success: false,
          error: 'File is required'
        });
      }

      console.log('[REGISTER] File received', {
        filename: file.originalname,
        size: file.size,
        mimetype: file.mimetype
      });

      // Validate password strength
      if (password.length < 6) {
        if (file) {
          safeUnlink(file.path);
          console.log('[REGISTER] Password too short - cleaned up file');
        }
        console.warn('[REGISTER] Registration failed - Password too short', {
          email,
          passwordLength: password.length
        });
        return res.status(400).json({
          success: false,
          error: 'Password must be at least 6 characters long'
        });
      }

      // Check if user already exists
      console.log('[REGISTER] Checking if user already exists', { email });
      const { data: existingUser } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('email', email)
        .single();

      if (existingUser) {
        if (file) {
          safeUnlink(file.path);
          console.log('[REGISTER] User already exists - cleaned up file');
        }
        console.warn('[REGISTER] Registration failed - User already exists', { email });
        return res.status(400).json({
          success: false,
          error: 'User with this email already exists'
        });
      }

      if (organizationType === ORGANIZATION_TYPES.EMPLOYEE) {
        console.log('[REGISTER] Looking up organization for employee registration', {
          email,
          organizationCode: organizationCodeInput
        });

        const { data: existingOrganization, error: organizationLookupError } = await supabaseAdmin
          .from('organizations')
          .select('id, organization_code, name')
          .eq('organization_code', organizationCodeInput)
          .maybeSingle();

        if (organizationLookupError) {
          throw organizationLookupError;
        }

        if (!existingOrganization) {
          safeUnlink(file.path);
          return res.status(400).json({
            success: false,
            error: 'Organization ID not found'
          });
        }

        resolvedOrganization = existingOrganization;
      }

      console.log('[REGISTER] Hashing password');
      // Hash password using bcrypt
      const saltRounds = 10;
      const password_hash = await bcrypt.hash(password, saltRounds);
      console.log('[REGISTER] Password hashed successfully');

      // Step 1: Upload file to Supabase Storage bucket "signup-files"
      console.log('[REGISTER] Starting file upload to Supabase Storage', {
        originalFilename: file.originalname,
        localPath: file.path
      });

      const fileBuffer = fs.readFileSync(file.path);
      const fileExt = path.extname(file.originalname);
      const timestamp = Date.now();
      const fileName = `${timestamp}-${Math.round(Math.random() * 1E9)}${fileExt}`;
      const filePath = `signup-documents/${fileName}`;
      uploadedStoragePath = filePath;

      console.log('[REGISTER] Uploading file to storage', {
        storagePath: filePath,
        bucket: 'signup-files'
      });

      const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
        .from('signup-files')
        .upload(filePath, fileBuffer, {
          contentType: file.mimetype,
          upsert: false
        });

      if (uploadError) {
        fs.unlinkSync(file.path);
        console.error('[REGISTER] File upload failed', {
          email,
          error: uploadError.message,
          filePath
        });
        return res.status(500).json({
          success: false,
          error: `File upload failed: ${uploadError.message}`
        });
      }

      console.log('[REGISTER] File uploaded successfully', {
        filePath,
        uploadData: uploadData?.path || uploadData
      });

      storageUploadCompleted = true;

      // Get public URL for the uploaded file
      console.log('[REGISTER] Generating public URL for file');
      const urlData = supabaseAdmin.storage
        .from('signup-files')
        .getPublicUrl(filePath);

      let publicUrl;
      if (urlData.data && urlData.data.publicUrl) {
        publicUrl = urlData.data.publicUrl;
      } else if (urlData.publicUrl) {
        publicUrl = urlData.publicUrl;
      } else {
        // Fallback: construct URL manually
        const supabaseUrl = process.env.SUPABASE_URL;
        publicUrl = `${supabaseUrl}/storage/v1/object/public/signup-files/${filePath}`;
        console.log('[REGISTER] Using fallback URL construction');
      }

      console.log('[REGISTER] File URL generated', { publicUrl });

      // Step 2: Save user to database with approval_status='pending' and role='user'
      if (organizationType === ORGANIZATION_TYPES.NEW) {
        const organizationCode = await generateOrganizationCode();
        const normalizedOrganizationName = normalizeOrganizationName(organizationName);

        const { data: createdOrganization, error: organizationCreateError } = await supabaseAdmin
          .from('organizations')
          .insert({
            organization_code: organizationCode,
            name: organizationName,
            normalized_name: normalizedOrganizationName
          })
          .select('id, organization_code, name')
          .single();

        if (organizationCreateError) {
          throw organizationCreateError;
        }

        createdOrganizationId = createdOrganization.id;
        createdOrganizationCode = createdOrganization.organization_code;
        resolvedOrganization = createdOrganization;
      }

      console.log('[REGISTER] Saving user to database', {
        email,
        company_name: resolvedOrganization?.name || organizationName,
        organization_code: resolvedOrganization?.organization_code,
        organization_type: organizationType,
        role: 'user',
        approval_status: 'pending'
      });

      const { data: userData, error: dbError } = await supabaseAdmin
        .from('users')
        .insert({
          name: name,
          email: email,
          password_hash: password_hash,
          company_name: resolvedOrganization.name,
          file_url: publicUrl,
          file_name: file.originalname,
          organization_ref: resolvedOrganization.id,
          organization_code: resolvedOrganization.organization_code,
          organization_role: organizationType === ORGANIZATION_TYPES.EMPLOYEE ? 'employee' : 'primary',
          kyc_required: organizationType !== ORGANIZATION_TYPES.EMPLOYEE,
          role: 'user', // Default role for regular users
          approval_status: 'pending' // User needs admin approval
        })
        .select('id, name, email, company_name, organization_code, organization_role, kyc_required, role, approval_status, created_at')
        .single();

      if (dbError) {
        // Clean up: delete uploaded file from storage and local file
        console.error('[REGISTER] Database error - cleaning up uploaded file', {
          email,
          error: dbError.message,
          filePath
        });

        if (uploadData) {
          const { error: deleteError } = await supabaseAdmin.storage.from('signup-files').remove([filePath]);
          if (deleteError) {
            console.error('[REGISTER] Failed to delete file from storage during cleanup', {
              error: deleteError.message
            });
          } else {
            console.log('[REGISTER] File deleted from storage during cleanup');
          }
        }
        if (createdOrganizationId) {
          const { error: organizationCleanupError } = await supabaseAdmin
            .from('organizations')
            .delete()
            .eq('id', createdOrganizationId);

          if (organizationCleanupError) {
            console.error('[REGISTER] Failed to delete organization during cleanup', {
              organizationId: createdOrganizationId,
              organizationCode: createdOrganizationCode,
              error: organizationCleanupError.message
            });
          }
        }
        safeUnlink(file.path);
        console.log('[REGISTER] Local file cleaned up');
        
        return res.status(500).json({
          success: false,
          error: `Database error: ${dbError.message}`
        });
      }

      console.log('[REGISTER] User saved to database successfully', {
        userId: userData.id,
        email: userData.email
      });

      // Clean up local file after successful upload
      safeUnlink(file.path);
      console.log('[REGISTER] Local file cleaned up');

      if (createdOrganizationId) {
        await supabaseAdmin
          .from('organizations')
          .update({ created_by_user_id: userData.id })
          .eq('id', createdOrganizationId);
      }

      createdOrganizationId = null;
      createdOrganizationCode = null;

      // Return success response
      const duration = Date.now() - startTime;
      console.log('[REGISTER] Registration completed successfully', {
        userId: userData.id,
        email: userData.email,
        duration: `${duration}ms`,
        timestamp: new Date().toISOString()
      });

      res.status(201).json({
        success: true,
        message: 'Registration successful! Your account is pending admin approval.',
        user: userData
      });

    } catch (error) {
      if (storageUploadCompleted && uploadedStoragePath) {
        const { error: storageCleanupError } = await supabaseAdmin.storage
          .from('signup-files')
          .remove([uploadedStoragePath]);

        if (storageCleanupError) {
          console.error('[REGISTER] Failed to clean up uploaded storage file after error', {
            path: uploadedStoragePath,
            error: storageCleanupError.message
          });
        }
      }

      if (createdOrganizationId) {
        const { error: organizationCleanupError } = await supabaseAdmin
          .from('organizations')
          .delete()
          .eq('id', createdOrganizationId);

        if (organizationCleanupError) {
          console.error('[REGISTER] Failed to clean up organization after error', {
            organizationId: createdOrganizationId,
            organizationCode: createdOrganizationCode,
            error: organizationCleanupError.message
          });
        }
      }

      // Clean up local file if it exists
      if (req.file && fs.existsSync(req.file.path)) {
        try {
          safeUnlink(req.file.path);
          console.log('[REGISTER] Local file cleaned up after error');
        } catch (cleanupError) {
          console.error('[REGISTER] Failed to clean up file after error', {
            error: cleanupError.message
          });
        }
      }

      const duration = Date.now() - startTime;
      console.error('[REGISTER] Registration failed with error', {
        email: req.body.email || 'unknown',
        error: error.message,
        stack: error.stack,
        duration: `${duration}ms`,
        timestamp: new Date().toISOString()
      });

      const isDuplicateOrganizationName =
        error?.code === '23505' && String(error.message || '').toLowerCase().includes('normalized_name');

      res.status(isDuplicateOrganizationName ? 400 : 500).json({
        success: false,
        error: isDuplicateOrganizationName
          ? 'An organization with this name already exists. Use the existing organization ID to register as an employee.'
          : (error.message || 'Internal server error')
      });
    }
  }
);

module.exports = router;

