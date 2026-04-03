const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');
const generateOrderPdf = require('../utils/generateOrderPdf');
const uploadAwbToSupabase = require('../utils/uploadAWBtoSupabase');

const generateAWB = () => {
  return `AWB-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
};

const generate6DigitCode = () => {
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
};

const isDuplicateKeyError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('duplicate key') || message.includes('unique');
};

const orderUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB per file
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

const uploadOrderDocuments = async (files, awbNumber, folder) => {
  if (!files || files.length === 0) return [];

  const uploads = files.map(async (file) => {
    const safeName = sanitizeFileName(file.originalname || 'document');
    const filePath = `orders/${awbNumber}/${folder}/${Date.now()}_${safeName}`;

    const { error } = await supabaseAdmin.storage
      .from('order-documents')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype
      });

    if (error) throw error;

    const { data } = supabaseAdmin.storage
      .from('order-documents')
      .getPublicUrl(filePath);

    return data.publicUrl;
  });

  return Promise.all(uploads);
};


// Calculate shipping quote endpoint
router.post('/quote', authenticateToken, async (req, res) => {
  try {
    const {
      pickupCountry,
      pickupPincode,
      destinationCountry,
      destinationPincode,
      actualWeight,
      length,
      breadth,
      height,
      shipmentValue,
      requireBOE,
      requireDO
    } = req.body;

    // Validate required fields
    if (!pickupCountry || !pickupPincode || !destinationCountry || !destinationPincode || !actualWeight) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: pickupCountry, pickupPincode, destinationCountry, destinationPincode, actualWeight'
      });
    }

    // Validate weight is a positive number
    const weight = parseFloat(actualWeight);
    if (isNaN(weight) || weight <= 0) {
      return res.status(400).json({
        success: false,
        error: 'actualWeight must be a positive number'
      });
    }

    // Optional: Validate dimensions if provided
    const dimensions = {};
    if (length) {
      const len = parseFloat(length);
      if (!isNaN(len) && len > 0) dimensions.length = len;
    }
    if (breadth) {
      const br = parseFloat(breadth);
      if (!isNaN(br) && br > 0) dimensions.breadth = br;
    }
    if (height) {
      const ht = parseFloat(height);
      if (!isNaN(ht) && ht > 0) dimensions.height = ht;
    }

    // Optional: Validate shipment value if provided
    let shipmentValueNum = null;
    if (shipmentValue) {
      shipmentValueNum = parseFloat(shipmentValue);
      if (isNaN(shipmentValueNum) || shipmentValueNum < 0) {
        return res.status(400).json({
          success: false,
          error: 'shipmentValue must be a non-negative number'
        });
      }
    }

    // Calculate additional charges
    const boeCharge = (requireBOE === true || requireBOE === 'true') ? 100 : 0;
    const doCharge = (requireDO === true || requireDO === 'true') ? 100 : 0;

    // 3. EXPORT DECLARATION (mandatory for export booking from UAE) - 120aed
    const isUae = (country) => {
      if (!country) return false;
      const c = country.toLowerCase().trim();
      return c === 'uae' || c === 'united arab emirates';
    };

    // Check if it's an export from UAE (Pickup is UAE, Destination is NOT UAE)
    const isExportFromUae = isUae(pickupCountry) && !isUae(destinationCountry);

    const exportDeclarationCharge = isExportFromUae ? 120 : 0;
    const additionalCharges = boeCharge + doCharge + exportDeclarationCharge;

    // Calculate shipping costs based on weight (cost = weight * rate)
    // DHL: 10 dirham per kg
    // FedEx: 8 dirham per kg
    // UPS: 6 dirham per kg
    const dhlRate = 10;
    const fedexRate = 8;
    const upsRate = 6;
    
    const dhlBaseCost = weight * dhlRate;
    const fedexBaseCost = weight * fedexRate;
    const upsBaseCost = weight * upsRate;

    const dhlCost = dhlBaseCost + additionalCharges;
    const fedexCost = fedexBaseCost + additionalCharges;
    const upsCost = upsBaseCost + additionalCharges;

    // Generate random estimated delivery times (in days)
    // Random between 3-7 days for international shipping
    const getRandomDeliveryDays = (min, max) => {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    };
    
    // Function to calculate estimated delivery date and time
    const calculateDeliveryDateTime = (deliveryDays) => {
      const now = new Date();
      let deliveryDate = new Date(now);
      
      // Add business days (skip weekends)
      let daysAdded = 0;
      while (daysAdded < deliveryDays) {
        deliveryDate.setDate(deliveryDate.getDate() + 1);
        // Skip weekends (Saturday = 6, Sunday = 0)
        if (deliveryDate.getDay() !== 0 && deliveryDate.getDay() !== 6) {
          daysAdded++;
        }
      }
      
      // Generate random time between 9 AM and 6 PM (business hours)
      const randomHour = Math.floor(Math.random() * 9) + 9; // 9-17 (9 AM to 5 PM)
      const randomMinute = Math.floor(Math.random() * 60); // 0-59
      
      deliveryDate.setHours(randomHour, randomMinute, 0, 0);
      
      // Format date and time
      const dateStr = deliveryDate.toISOString().split('T')[0];
      const timeStr = deliveryDate.toTimeString().split(' ')[0];
      const dateTimeISO = deliveryDate.toISOString();
      
      // Format readable date and time
      const options = { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      };
      const readableDateTime = deliveryDate.toLocaleString('en-US', options);
      
      return {
        date: dateStr,
        time: timeStr,
        dateTime: dateTimeISO,
        readable: readableDateTime
      };
    };
    
    const dhlDeliveryDays = getRandomDeliveryDays(3, 7);
    const fedexDeliveryDays = getRandomDeliveryDays(3, 7);
    const upsDeliveryDays = getRandomDeliveryDays(3, 7);
    
    const dhlDeliveryDateTime = calculateDeliveryDateTime(dhlDeliveryDays);
    const fedexDeliveryDateTime = calculateDeliveryDateTime(fedexDeliveryDays);
    const upsDeliveryDateTime = calculateDeliveryDateTime(upsDeliveryDays);

    // Prepare response with calculated data
    const quoteData = {
      pickup: {
        country: pickupCountry,
        pincode: pickupPincode
      },
      destination: {
        country: destinationCountry,
        pincode: destinationPincode
      },
      weight: {
        actualWeight: weight,
        unit: 'kg'
      },
      dimensions: Object.keys(dimensions).length > 0 ? {
        ...dimensions,
        unit: 'cm'
      } : null,
      shipmentValue: shipmentValueNum ? {
        value: shipmentValueNum,
        currency: 'AED'
      } : null,
      quotes: [
        {
          carrier: 'DHL',
          cost: dhlCost,
          costBreakdown: {
            weight: weight,
            ratePerKg: dhlRate,
            baseShippingCost: dhlBaseCost,
            complianceCharges: {
              boeCharge,
              doCharge,
              exportDeclarationCharge
            },
            additionalCharges,
            totalCost: dhlCost,
            currency: 'AED'
          },
          currency: 'AED',
          estimatedDeliveryDays: dhlDeliveryDays,
          estimatedDelivery: `${dhlDeliveryDays} business days`,
          estimatedDeliveryDate: dhlDeliveryDateTime.date,
          estimatedDeliveryTime: dhlDeliveryDateTime.time,
          estimatedDeliveryDateTime: dhlDeliveryDateTime.dateTime,
          estimatedDeliveryReadable: dhlDeliveryDateTime.readable
        },
        {
          carrier: 'FedEx',
          cost: fedexCost,
          costBreakdown: {
            weight: weight,
            ratePerKg: fedexRate,
            baseShippingCost: fedexBaseCost,
            complianceCharges: {
              boeCharge,
              doCharge,
              exportDeclarationCharge
            },
            additionalCharges,
            totalCost: fedexCost,
            currency: 'AED'
          },
          currency: 'AED',
          estimatedDeliveryDays: fedexDeliveryDays,
          estimatedDelivery: `${fedexDeliveryDays} business days`,
          estimatedDeliveryDate: fedexDeliveryDateTime.date,
          estimatedDeliveryTime: fedexDeliveryDateTime.time,
          estimatedDeliveryDateTime: fedexDeliveryDateTime.dateTime,
          estimatedDeliveryReadable: fedexDeliveryDateTime.readable
        },
        {
          carrier: 'UPS',
          cost: upsCost,
          costBreakdown: {
            weight: weight,
            ratePerKg: upsRate,
            baseShippingCost: upsBaseCost,
            complianceCharges: {
              boeCharge,
              doCharge,
              exportDeclarationCharge
            },
            additionalCharges,
            totalCost: upsCost,
            currency: 'AED'
          },
          currency: 'AED',
          estimatedDeliveryDays: upsDeliveryDays,
          estimatedDelivery: `${upsDeliveryDays} business days`,
          estimatedDeliveryDate: upsDeliveryDateTime.date,
          estimatedDeliveryTime: upsDeliveryDateTime.time,
          estimatedDeliveryDateTime: upsDeliveryDateTime.dateTime,
          estimatedDeliveryReadable: upsDeliveryDateTime.readable
        }
      ],
      calculatedAt: new Date().toISOString()
    };

    res.json({
      success: true,
      data: quoteData
    });

  } catch (error) {
    console.error('Shipping quote error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Create order endpoint
router.post(
  '/order',
  authenticateToken,
  orderUpload.fields([
    { name: 'invoices', maxCount: 10 },
    { name: 'packing-list', maxCount: 10 },
    { name: 'packing_list', maxCount: 10 },
    { name: 'packing-lists', maxCount: 10 }
  ]),
  async (req, res) => {
  try {
    const userId = req.user.id; 
    console.log('Create order debug: body keys', Object.keys(req.body || {}));
    console.log('Create order debug: file fields', Object.keys(req.files || {}));

    const parseJsonField = (value, fallback) => {
      if (value === undefined || value === null || value === '') return fallback;
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch (err) {
        throw new Error('Invalid JSON in multipart field');
      }
    };

    const orderFromBody = parseJsonField(req.body.order, null);
    const orderSource = orderFromBody || req.body;

    const pickupCountry = orderSource.pickupCountry;
    const pickupPincode = orderSource.pickupPincode;
    const destinationCountry = orderSource.destinationCountry;
    const destinationPincode = orderSource.destinationPincode;
    const actualWeight = orderSource.actualWeight;
    const shipmentValue = orderSource.shipmentValue;
    const addressFormId = orderSource.addressFormId;

    const boxes = parseJsonField(orderSource.boxes, []);
    const parsedCarrier = parseJsonField(orderSource.carrier, null);
    const parsedCompliance = parseJsonField(orderSource.compliance, null);

    if (
      !pickupCountry ||
      !pickupPincode ||
      !destinationCountry ||
      !destinationPincode ||
      !actualWeight ||
      !parsedCarrier ||
      !Array.isArray(boxes) ||
      boxes.length === 0
    ) {
      const missingFields = [];
      if (!pickupCountry) missingFields.push('pickupCountry');
      if (!pickupPincode) missingFields.push('pickupPincode');
      if (!destinationCountry) missingFields.push('destinationCountry');
      if (!destinationPincode) missingFields.push('destinationPincode');
      if (!actualWeight) missingFields.push('actualWeight');
      if (!parsedCarrier) missingFields.push('carrier');
      if (!Array.isArray(boxes)) missingFields.push('boxes (not an array)');
      if (Array.isArray(boxes) && boxes.length === 0) missingFields.push('boxes (empty)');

      console.warn('Create order missing fields:', missingFields);
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        missing: missingFields
      });
    }

    const declaredWeight = parseFloat(actualWeight);
    if (isNaN(declaredWeight) || declaredWeight <= 0) {
      return res.status(400).json({
        success: false,
        error: 'actualWeight must be a positive number'
      });
    }

    let addressForm = null;
    if (addressFormId) {
      const { data: existingAddressForm, error: addressFormError } = await supabaseAdmin
        .from('order_address_forms')
        .select('id, user_id, status')
        .eq('id', addressFormId)
        .eq('user_id', userId)
        .single();

      if (addressFormError || !existingAddressForm) {
        return res.status(404).json({
          success: false,
          error: 'Address form not found'
        });
      }

      if (existingAddressForm.status === 'ordered') {
        return res.status(400).json({
          success: false,
          error: 'Address form has already been used for an order'
        });
      }

      addressForm = existingAddressForm;
    }

    const DIVISOR = 5000;
    let totalChargeableWeight = 0;

    const processedBoxes = boxes.map((box, index) => {
      const { quantity, actualWeight, length, breadth, height } = box;

      if (!quantity || !actualWeight || !length || !breadth || !height) {
        throw new Error(`Invalid box at index ${index}`);
      }

      const volumetric = (length * breadth * height) / DIVISOR;
      const chargeable = Math.max(actualWeight, volumetric);

      totalChargeableWeight += chargeable * quantity;

      return {
        quantity,
        actualWeight,
        dimensions: { length, breadth, height, unit: 'cm' },
        volumetricWeight: Number(volumetric.toFixed(2)),
        chargeableWeight: Number(chargeable.toFixed(2))
      };
    });

    // Process compliance data
    let complianceData = {
      requireBOE: false,
      requireDO: false,
      exportDeclaration: false,
      exportDeclarationCharge: 0,
      dutyExemption: false
    };

    let totalComplianceCharges = 0;

    if (parsedCompliance) {
      // 1. REQUIRE BOE
      if (parsedCompliance.requireBOE === true || parsedCompliance.requireBOE === 'true') {
        complianceData.requireBOE = true;
        totalComplianceCharges += 100;
      }

      // 2. REQUIRE D/O
      if (parsedCompliance.requireDO === true || parsedCompliance.requireDO === 'true') {
        complianceData.requireDO = true;
        totalComplianceCharges += 100;
      }

      // 4. DUTY EXEMPTION
      if (parsedCompliance.dutyExemption === true || parsedCompliance.dutyExemption === 'true') {
        complianceData.dutyExemption = true;
      }
    }

    // 3. EXPORT DECLARATION (mandatory for export booking from UAE)
    const isUae = (country) => {
      if (!country) return false;
      const c = country.toLowerCase().trim();
      return c === 'uae' || c === 'united arab emirates';
    };

    const isExportFromUae = isUae(pickupCountry) && !isUae(destinationCountry);

    if (isExportFromUae) {
      complianceData.exportDeclaration = true;
      complianceData.exportDeclarationCharge = 120;
      totalComplianceCharges += 120;
    } else if (parsedCompliance && (parsedCompliance.exportDeclaration === true || parsedCompliance.exportDeclaration === 'true')) {
      // Allow it if explicitly requested, even if not mandatory? Or strictly enforce logic?
      // Assuming if passed, we keep it, but ensure mandatory rule is respected above.
      complianceData.exportDeclaration = true;
      complianceData.exportDeclarationCharge = 120; // Default charge if not provided, or should we use input?
      if (parsedCompliance.exportDeclarationCharge) {
        complianceData.exportDeclarationCharge = parseFloat(parsedCompliance.exportDeclarationCharge) || 120;
      }
      totalComplianceCharges += complianceData.exportDeclarationCharge;
    }

    // Build and persist a normalized carrier cost breakdown on order data.
    if (parsedCarrier && (parsedCarrier.cost !== undefined && parsedCarrier.cost !== null)) {
      const carrierName = String(parsedCarrier.carrier || '').toLowerCase().trim();
      const quoteRateByCarrier = {
        dhl: 10,
        fedex: 8,
        ups: 6
      };

      const toNumber = (value, fallback = 0) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
      };

      const incomingCost = toNumber(parsedCarrier.cost, 0);
      const existingBreakdown = (parsedCarrier.costBreakdown && typeof parsedCarrier.costBreakdown === 'object')
        ? parsedCarrier.costBreakdown
        : null;
      const existingAdditionalCharges = toNumber(existingBreakdown?.additionalCharges, 0);
      const complianceAlreadyIncluded = existingBreakdown && existingAdditionalCharges === totalComplianceCharges;

      let baseShippingCost = existingBreakdown
        ? toNumber(existingBreakdown.baseShippingCost, incomingCost - existingAdditionalCharges)
        : incomingCost;

      if (baseShippingCost < 0) baseShippingCost = 0;

      const finalCarrierCost = complianceAlreadyIncluded
        ? incomingCost
        : (baseShippingCost + totalComplianceCharges);

      let ratePerKg = toNumber(
        existingBreakdown?.ratePerKg,
        toNumber(parsedCarrier.ratePerKg, 0)
      );

      if (!ratePerKg && quoteRateByCarrier[carrierName]) {
        ratePerKg = quoteRateByCarrier[carrierName];
      } else if (!ratePerKg && declaredWeight > 0) {
        ratePerKg = baseShippingCost / declaredWeight;
      }

      const boeCharge = complianceData.requireBOE ? 100 : 0;
      const doCharge = complianceData.requireDO ? 100 : 0;
      const exportDeclarationCharge = complianceData.exportDeclaration
        ? complianceData.exportDeclarationCharge
        : 0;

      parsedCarrier.cost = Number(finalCarrierCost.toFixed(2));
      parsedCarrier.currency = parsedCarrier.currency || 'AED';
      parsedCarrier.costBreakdown = {
        weight: declaredWeight,
        ratePerKg: Number(ratePerKg.toFixed(2)),
        baseShippingCost: Number(baseShippingCost.toFixed(2)),
        complianceCharges: {
          boeCharge,
          doCharge,
          exportDeclarationCharge: Number(exportDeclarationCharge.toFixed(2))
        },
        additionalCharges: Number(totalComplianceCharges.toFixed(2)),
        totalCost: Number(finalCarrierCost.toFixed(2)),
        currency: parsedCarrier.currency
      };
    }

    const orderPayload = {
      orderId: `ORD-${Date.now()}`,
      user: {
        id: userId,
        name: req.user.name,
        company: req.user.company_name
      },
      pickup: { country: pickupCountry, pincode: pickupPincode },
      destination: { country: destinationCountry, pincode: destinationPincode },
      compliance: complianceData,
      weight: {
        declared: declaredWeight,
        chargeable: Number(totalChargeableWeight.toFixed(2)),
        unit: 'kg'
      },
      boxes: processedBoxes,
      shipmentValue: shipmentValue
        ? { value: shipmentValue, currency: 'AED' }
        : null,
      status: 'CREATED',
      createdAt: new Date().toISOString()
    };

    const awbNumber = generateAWB();

    orderPayload.awb_number = awbNumber;

    const invoiceFiles = req.files?.invoices || [];
    const packingListFiles = [
      ...(req.files?.['packing-list'] || []),
      ...(req.files?.packing_list || []),
      ...(req.files?.['packing-lists'] || [])
    ];

    const [invoiceUrls, packingListUrls] = await Promise.all([
      uploadOrderDocuments(invoiceFiles, awbNumber, 'invoices'),
      uploadOrderDocuments(packingListFiles, awbNumber, 'packing-list')
    ]);

    orderPayload.invoice_urls = invoiceUrls;
    orderPayload.packing_list_urls = packingListUrls;

    // Generate PDF
    const pdfBuffer = await generateOrderPdf(orderPayload);

    // Upload PDF
    const pdfUrl = await uploadAwbToSupabase(
      supabaseAdmin,
      pdfBuffer,
      awbNumber
    );

    // Save order
    const { data, error } = await supabaseAdmin
      .from('orders')
      .insert({
        user_id: userId,
        awb_number: awbNumber,
        awb_pdf_url: pdfUrl,
        invoice_urls: invoiceUrls,
        packing_list_urls: packingListUrls,
        order_data: orderPayload,
        carrier: parsedCarrier,
        status: 'CREATED'
      })
      .select()
      .single();

    if (error) throw error;

    if (addressForm) {
      const { error: addressFormUpdateError } = await supabaseAdmin
        .from('order_address_forms')
        .update({
          status: 'ordered'
        })
        .eq('id', addressForm.id)
        .eq('user_id', userId);

      if (addressFormUpdateError) throw addressFormUpdateError;
    }

    return res.status(201).json({
      success: true,
      message: 'Order created successfully',
      data
    });
  } catch (error) {
    console.error('Create order error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
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
    console.error('Shipping router error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error'
    });
  }
  next();
});

router.get('/orders', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  console.log(userId);

  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ success: false, error: error.message });
  }

  res.json({ success: true, data });
});

// Get orders for a specific user (admin or owner)
router.get('/orders/user/:userId', authenticateToken, async (req, res) => {
  const { userId } = req.params;

  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Access denied'
    });
  }

  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ success: false, error: error.message });
  }

  res.json({ success: true, data });
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

