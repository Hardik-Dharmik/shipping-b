const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');
const generateOrderPdf = require('../utils/generateOrderPdf');
const uploadAwbToSupabase = require('../utils/uploadAWBtoSupabase');
const { getTwentyOneKgOfferMessage } = require('../utils/chargeableWeightOffers');

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
    const input = normalizeInput(req.body);

    // 1. Validate input
    const validationError = validateInput(input);
    if (validationError) {
      return res.status(400).json({ success: false, error: validationError });
    }

    // 2. Compute charges
    const charges = calculateCharges(input);

    // 3. Generate carrier quotes
    const quotes = generateQuotes(input.weight, charges.additionalCharges);

    // 4. Build response
    const response = buildResponse(input, quotes);

    return res.json({ success: true, data: response });

  } catch (error) {
    console.error('Shipping quote error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});


// -------------------- HELPERS --------------------

// Normalize & parse input
function normalizeInput(body) {
  return {
    pickupCountry: body.pickupCountry?.trim(),
    pickupPincode: body.pickupPincode,
    destinationCountry: body.destinationCountry?.trim(),
    destinationPincode: body.destinationPincode,
    weight: parseFloat(body.actualWeight),
    dimensions: parseDimensions(body),
    shipmentValue: parseOptionalNumber(body.shipmentValue),
    compliance: {
      requireBOE: parseBoolean(body.requireBOE),
      requireDO: parseBoolean(body.requireDO),
      tempExport: parseBoolean(body.temporaryExportForRepairAndReturn)
    }
  };
}

// Validation
function validateInput(input) {
  const requiredFields = [
    'pickupCountry',
    'pickupPincode',
    'destinationCountry',
    'destinationPincode'
  ];

  for (const field of requiredFields) {
    if (!input[field]) return `Missing required field: ${field}`;
  }

  if (!input.weight || input.weight <= 0) {
    return 'actualWeight must be a positive number';
  }

  if (input.shipmentValue !== null && input.shipmentValue < 0) {
    return 'shipmentValue must be a non-negative number';
  }

  return null;
}

// Parse helpers
function parseDimensions({ length, breadth, height }) {
  const dims = {};

  if (isPositiveNumber(length)) dims.length = parseFloat(length);
  if (isPositiveNumber(breadth)) dims.breadth = parseFloat(breadth);
  if (isPositiveNumber(height)) dims.height = parseFloat(height);

  return Object.keys(dims).length ? dims : null;
}

function parseOptionalNumber(val) {
  const num = parseFloat(val);
  return isNaN(num) ? null : num;
}

function parseBoolean(val) {
  return val === true || val === 'true';
}

function isPositiveNumber(val) {
  const num = parseFloat(val);
  return !isNaN(num) && num > 0;
}

// Charges calculation
function calculateCharges(input) {
  const boeCharge = input.compliance.requireBOE ? 100 : 0;
  const doCharge = input.compliance.requireDO ? 100 : 0;
  const tempExportCharge = input.compliance.tempExport ? 380 : 0;

  const exportDeclarationCharge =
    isExportFromUAE(input.pickupCountry, input.destinationCountry) ? 120 : 0;

  const additionalCharges =
    boeCharge + doCharge + tempExportCharge + exportDeclarationCharge;

  return {
    boeCharge,
    doCharge,
    tempExportCharge,
    exportDeclarationCharge,
    additionalCharges
  };
}

// UAE logic
function isExportFromUAE(pickup, destination) {
  const isUae = (c) =>
    ['uae', 'united arab emirates'].includes(c?.toLowerCase());

  return isUae(pickup) && !isUae(destination);
}

// Generate quotes
function generateQuotes(weight, additionalCharges) {
  const carriers = [
    { name: 'DHL', rate: 10 },
    { name: 'FedEx', rate: 8 },
    { name: 'UPS', rate: 6 }
  ];

  return carriers.map(carrier => {
    const baseCost = weight * carrier.rate;
    const totalCost = baseCost + additionalCharges;

    const days = randomBetween(3, 7);
    const delivery = calculateDeliveryDateTime(days);

    return {
      carrier: carrier.name,
      cost: totalCost,
      currency: 'AED',
      estimatedDeliveryDays: days,
      estimatedDelivery: `${days} business days`,
      ...delivery,
      costBreakdown: {
        weight,
        ratePerKg: carrier.rate,
        baseShippingCost: baseCost,
        additionalCharges,
        totalCost,
        currency: 'AED'
      }
    };
  });
}

// Date helpers
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function calculateDeliveryDateTime(days) {
  const date = new Date();
  let added = 0;

  while (added < days) {
    date.setDate(date.getDate() + 1);
    if (![0, 6].includes(date.getDay())) added++;
  }

  date.setHours(randomBetween(9, 17), randomBetween(0, 59), 0, 0);

  return {
    estimatedDeliveryDate: date.toISOString().split('T')[0],
    estimatedDeliveryTime: date.toTimeString().split(' ')[0],
    estimatedDeliveryDateTime: date.toISOString(),
    estimatedDeliveryReadable: date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    })
  };
}

// Build final response
function buildResponse(input, quotes) {
  const offerMessage = getTwentyOneKgOfferMessage({
    pickupCountry: input.pickupCountry,
    destinationCountry: input.destinationCountry,
    actualWeight: input.weight,
    dimensions: input.dimensions
  });

  return {
    pickup: {
      country: input.pickupCountry,
      pincode: input.pickupPincode
    },
    destination: {
      country: input.destinationCountry,
      pincode: input.destinationPincode
    },
    weight: {
      actualWeight: input.weight,
      unit: 'kg'
    },
    dimensions: input.dimensions
      ? { ...input.dimensions, unit: 'cm' }
      : null,
    shipmentValue: input.shipmentValue
      ? { value: input.shipmentValue, currency: 'AED' }
      : null,
    compliance: input.compliance,
    offers: offerMessage ? [offerMessage] : [],
    quotes,
    calculatedAt: new Date().toISOString()
  };
}

const parseOrderData = (req) => {
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

      return {
      pickupCountry: orderSource.pickupCountry,
      pickupPincode: orderSource.pickupPincode,
      destinationCountry: orderSource.destinationCountry,
      destinationPincode: orderSource.destinationPincode,
      actualWeight: orderSource.actualWeight,
      shipmentValue: orderSource.shipmentValue,
      addressFormId: orderSource.addressFormId,
      boxes: parseJsonField(orderSource.boxes, []),
      parsedCarrier: parseJsonField(orderSource.carrier, null),
      parsedCompliance: parseJsonField(orderSource.compliance, null)
      };
};

const getProcessedBoxes = (boxes) => {
      return boxes.map((box, index) => {
      const { quantity, actualWeight, length, breadth, height } = box;

      if (!quantity || !actualWeight || !length || !breadth || !height) {
        throw new Error(`Invalid box at index ${index}`);
      }
      const DIVISOR = 5000;

      const volumetric = (length * breadth * height) / DIVISOR;
      const chargeable = Math.max(actualWeight, volumetric);

      let totalChargeableWeight = 0;

      totalChargeableWeight += chargeable * quantity;

      return {
        quantity,
        actualWeight,
        dimensions: { length, breadth, height, unit: 'cm' },
        volumetricWeight: Number(volumetric.toFixed(2)),
        chargeableWeight: Number(chargeable.toFixed(2))
      };
    })
}

const getComplianceData = (parsedCompliance) => {
    // Process compliance data
    let complianceData = {
      requireBOE: false,
      requireDO: false,
      exportDeclaration: false,
      exportDeclarationCharge: 0,
      dutyExemption: false,
      temporaryExportForRepairAndReturn: false
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

      if (
        parsedCompliance.temporaryExportForRepairAndReturn === true ||
        parsedCompliance.temporaryExportForRepairAndReturn === 'true'
      ) {
        complianceData.temporaryExportForRepairAndReturn = true;
        totalComplianceCharges += 380;
      }
    }
    return {complianceData, totalComplianceCharges};
   }

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

    const {
      pickupCountry,
      pickupPincode,
      destinationCountry,
      destinationPincode,
      actualWeight,
      shipmentValue,
      addressFormId,
      boxes,
      parsedCarrier,
      parsedCompliance
    } = parseOrderData(req);

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

    let totalChargeableWeight = 0;

    // const {processedBoxes, totalWeight} = getProcessedBoxes(boxes);
    // totalChargeableWeight = totalWeight;

    const processedBoxes = boxes.map((box, index) => {
      const { quantity, actualWeight, length, breadth, height } = box;

      if (!quantity || !actualWeight || !length || !breadth || !height) {
        throw new Error(`Invalid box at index ${index}`);
      }
      const DIVISOR = 5000;

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
    })

    let {complianceData, totalComplianceCharges} = getComplianceData(parsedCompliance);

    // 3. EXPORT DECLARATION (mandatory for export booking from UAE)
    const isExportFromUae = isExportFromUAE(pickupCountry, destinationCountry);

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

    // Recalculate carrier pricing from rates plus compliance charges, matching /quote.
    if (parsedCarrier) {
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

      const existingBreakdown = (parsedCarrier.costBreakdown && typeof parsedCarrier.costBreakdown === 'object')
        ? parsedCarrier.costBreakdown
        : null;

      let ratePerKg = toNumber(
        existingBreakdown?.ratePerKg,
        toNumber(parsedCarrier.ratePerKg, 0)
      );

      if (!ratePerKg && quoteRateByCarrier[carrierName]) {
        ratePerKg = quoteRateByCarrier[carrierName];
      }

      if (!ratePerKg && declaredWeight > 0) {
        const incomingCost = toNumber(parsedCarrier.cost, 0);
        const existingAdditionalCharges = toNumber(existingBreakdown?.additionalCharges, 0);
        const inferredBaseShippingCost = Math.max(
          0,
          incomingCost - Math.max(existingAdditionalCharges, totalComplianceCharges)
        );

        ratePerKg = inferredBaseShippingCost / declaredWeight;
      }

      const baseShippingCost = declaredWeight * ratePerKg;
      const finalCarrierCost = baseShippingCost + totalComplianceCharges;

      const boeCharge = complianceData.requireBOE ? 100 : 0;
      const doCharge = complianceData.requireDO ? 100 : 0;
      const exportDeclarationCharge = complianceData.exportDeclaration
        ? complianceData.exportDeclarationCharge
        : 0;
      const temporaryExportForRepairAndReturnCharge =
        complianceData.temporaryExportForRepairAndReturn ? 380 : 0;

      parsedCarrier.cost = Number(finalCarrierCost.toFixed(2));
      parsedCarrier.currency = parsedCarrier.currency || 'AED';
      parsedCarrier.costBreakdown = {
        weight: declaredWeight,
        ratePerKg: Number(ratePerKg.toFixed(2)),
        baseShippingCost: Number(baseShippingCost.toFixed(2)),
        complianceCharges: {
          boeCharge,
          doCharge,
          exportDeclarationCharge: Number(exportDeclarationCharge.toFixed(2)),
          temporaryExportForRepairAndReturnCharge: Number(temporaryExportForRepairAndReturnCharge.toFixed(2))
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

module.exports = router;

