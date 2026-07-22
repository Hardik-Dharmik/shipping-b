const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');
const generateOrderPdf = require('../utils/generateOrderPdf');
const uploadAwbToSupabase = require('../utils/uploadAWBtoSupabase');
const {
  getChargeableWeight,
  getOfferMessages,
  getRatePerKg
} = require('../utils/chargeableWeightOffers');

const generateAWB = () => {
  return `AWB-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
};

const generate6DigitCode = () => {
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
};

const generateRateCalculatorCode = () => `RC-${generate6DigitCode()}`;

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
    const quotes = generateQuotes(input, charges);

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

// Save calculator fields so the signed-in user can load them in Create Order.
router.post('/rate-calculator/save', authenticateToken, async (req, res) => {
  try {
    const input = normalizeInput(req.body);
    const validationError = validateInput(input);
    if (validationError) return res.status(400).json({ success: false, error: validationError });

    const charges = calculateCharges(input);
    const quoteData = buildResponse(input, generateQuotes(input, charges));
    let saved = null;

    for (let attempt = 0; attempt < 10; attempt++) {
      const { data, error } = await supabaseAdmin
        .from('rate_calculator_saves')
        .insert({
          user_id: req.user.id,
          code: generateRateCalculatorCode(),
          form_data: req.body,
          quote_data: quoteData
        })
        .select('id, code, form_data, quote_data, created_at')
        .single();

      if (!error) {
        saved = data;
        break;
      }
      if (!isDuplicateKeyError(error)) throw error;
    }

    if (!saved) throw new Error('Unable to generate a unique rate calculator code. Please retry.');

    return res.status(201).json({
      success: true,
      message: 'Rate calculator details saved successfully',
      data: {
        code: saved.code,
        formData: saved.form_data,
        quote: saved.quote_data,
        createdAt: saved.created_at
      }
    });
  } catch (error) {
    console.error('Save rate calculator error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

// Show the signed-in user's saved calculator entries, newest first.
// This route must appear before /rate-calculator/:code.
router.get('/rate-calculator/saved', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('rate_calculator_saves')
      .select('id, code, form_data, quote_data, created_at, updated_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({
      success: true,
      data: (data || []).map((item) => ({
        id: item.id,
        code: item.code,
        formData: item.form_data,
        quote: item.quote_data,
        createdAt: item.created_at,
        updatedAt: item.updated_at
      }))
    });
  } catch (error) {
    console.error('List saved rate calculators error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

// Create Order calls this after the user enters an RC-XXXXXX code.
router.get('/rate-calculator/:code', authenticateToken, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^RC-\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, error: 'Code must be in the format RC-123456' });
    }

    const { data, error } = await supabaseAdmin
      .from('rate_calculator_saves')
      .select('code, form_data, quote_data, created_at, updated_at')
      .eq('code', code)
      .eq('user_id', req.user.id)
      .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Saved rate calculator details not found' });

    return res.json({
      success: true,
      data: {
        code: data.code,
        formData: data.form_data,
        quote: data.quote_data,
        createdAt: data.created_at,
        updatedAt: data.updated_at
      }
    });
  } catch (error) {
    console.error('Get saved rate calculator error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});


// -------------------- HELPERS --------------------

// Normalize & parse input
function normalizeInput(body) {
  const compliance = body.compliance && typeof body.compliance === 'object' && !Array.isArray(body.compliance)
    ? body.compliance
    : {};
  const complianceValue = (name) => body[name] ?? compliance[name];
  const otherCharges = parseOptionalNumber(
    body.otherCharges ?? body.otherCharge ?? compliance.otherCharges ?? compliance.otherCharge
  );
  return {
    pickupCountry: body.pickupCountry?.trim(),
    pickupPincode: body.pickupPincode,
    destinationCountry: body.destinationCountry?.trim(),
    destinationPincode: body.destinationPincode,
    weight: parseFloat(body.actualWeight),
    dimensions: parseDimensions(body),
    boxes: parseBoxes(body.boxes),
    shipmentValue: parseOptionalNumber(body.shipmentValue),
    compliance: {
      requireBOE: parseBoolean(complianceValue('requireBOE')),
      requireDO: parseBoolean(complianceValue('requireDO')),
      dutyExemption: parseBoolean(complianceValue('dutyExemption')),
      tempExport: parseBoolean(complianceValue('temporaryExportForRepairAndReturn')),
      exportDeclaration: parseBoolean(complianceValue('exportDeclaration'))
    },
    otherCharges: otherCharges === null ? 0 : otherCharges,
    insurance: parseBoolean(complianceValue('insurance'))
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

  if (input.otherCharges < 0) return 'otherCharges must be a non-negative number';
  if (input.insurance && (!input.shipmentValue || input.shipmentValue <= 0)) {
    return 'shipmentValue is required when insurance is selected';
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

function parseBoxes(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
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
  // Insurance is AED 45 or 2% of declared invoice value, whichever is higher.
  const insuranceCharge = input.insurance
    ? Math.max(45, Number((input.shipmentValue * 0.02).toFixed(2)))
    : 0;
  const otherCharges = input.otherCharges;

  const additionalCharges =
    boeCharge + doCharge + tempExportCharge + exportDeclarationCharge + insuranceCharge + otherCharges;

  return {
    boeCharge,
    doCharge,
    tempExportCharge,
    exportDeclarationCharge,
    insuranceCharge,
    otherCharges,
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
function generateQuotes(input, charges) {
  const carriers = [
    { name: 'DHL', rate: 10 },
    { name: 'FedEx', rate: 8 },
    { name: 'UPS', rate: 6 }
  ];

  const chargeableWeight = getChargeableWeight(input.weight, input.dimensions);

  return carriers.map(carrier => {
    const ratePerKg = getRatePerKg({
      carrierName: carrier.name,
      pickupCountry: input.pickupCountry,
      destinationCountry: input.destinationCountry,
      actualWeight: input.weight,
      chargeableWeight,
      standardRatePerKg: carrier.rate,
      boxes: input.boxes
    });

    const baseCost = input.weight * ratePerKg;
    const totalCost = baseCost + charges.additionalCharges;

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
        weight: input.weight,
        chargeableWeight: Number.isFinite(chargeableWeight)
          ? Number(chargeableWeight.toFixed(2))
          : null,
        ratePerKg,
        baseShippingCost: baseCost,
        complianceCharges: {
          boeCharge: charges.boeCharge,
          doCharge: charges.doCharge,
          temporaryExportCharge: charges.tempExportCharge,
          exportDeclarationCharge: charges.exportDeclarationCharge,
          insuranceCharge: charges.insuranceCharge,
          otherCharges: charges.otherCharges
        },
        additionalCharges: charges.additionalCharges,
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
  const offers = getOfferMessages({
    pickupCountry: input.pickupCountry,
    destinationCountry: input.destinationCountry,
    actualWeight: input.weight,
    chargeableWeight: getChargeableWeight(input.weight, input.dimensions),
    dimensions: input.dimensions,
    boxes: input.boxes
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
    insurance: input.insurance
      ? { selected: true, charge: calculateCharges(input).insuranceCharge, currency: 'AED' }
      : { selected: false, charge: 0, currency: 'AED' },
    otherCharges: { amount: input.otherCharges, currency: 'AED' },
    offers,
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
      const parsedBoxes = parseJsonField(orderSource.boxes, []);
      const parsedCarrier = parseJsonField(orderSource.carrier, null);
      const parsedCompliance = parseJsonField(orderSource.compliance, null);
      const parsedPickupAddress = parseJsonField(orderSource.pickupAddress, null);
      const parsedDestinationAddress = parseJsonField(orderSource.destinationAddress, null);
      const parsedProducts = parseJsonField(orderSource.products, []);
      const parsedPackages = parseJsonField(orderSource.packages, []);
      const parsedOrderMeta = parseJsonField(orderSource.orderMeta, null);
      const otherCharges = parseOptionalNumber(
        orderSource.otherCharges ?? orderSource.otherCharge ?? parsedCompliance?.otherCharges
      );
      const insurance = parseBoolean(orderSource.insurance ?? parsedCompliance?.insurance);

      return {
      pickupCountry: orderSource.pickupCountry,
      pickupPincode: orderSource.pickupPincode,
      destinationCountry: orderSource.destinationCountry,
      destinationPincode: orderSource.destinationPincode,
      actualWeight: orderSource.actualWeight,
      shipmentValue: orderSource.shipmentValue,
      otherCharges: otherCharges === null ? 0 : otherCharges,
      insurance,
      addressFormId: orderSource.addressFormId,
      boxes: parsedBoxes,
      parsedCarrier,
      parsedCompliance,
      pickupAddress: parsedPickupAddress,
      destinationAddress: parsedDestinationAddress,
      products: Array.isArray(parsedProducts) ? parsedProducts : [],
      packages: Array.isArray(parsedPackages) ? parsedPackages : [],
      orderMeta: parsedOrderMeta,
      rawOrderData: {
        ...orderSource,
        boxes: parsedBoxes,
        carrier: parsedCarrier,
        compliance: parsedCompliance,
        pickupAddress: parsedPickupAddress,
        destinationAddress: parsedDestinationAddress,
        products: Array.isArray(parsedProducts) ? parsedProducts : [],
        packages: Array.isArray(parsedPackages) ? parsedPackages : [],
        orderMeta: parsedOrderMeta
      }
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

const getComplianceData = (parsedCompliance, { insurance = false, shipmentValue = null, otherCharges = 0 } = {}) => {
    // Process compliance data
    let complianceData = {
      requireBOE: false,
      requireDO: false,
      exportDeclaration: false,
      exportDeclarationCharge: 0,
      dutyExemption: false,
      temporaryExportForRepairAndReturn: false,
      insurance: Boolean(insurance),
      insuranceCharge: 0,
      otherCharges: Number(otherCharges) || 0
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

    if (complianceData.insurance) {
      complianceData.insuranceCharge = Math.max(45, Number((shipmentValue * 0.02).toFixed(2)));
      totalComplianceCharges += complianceData.insuranceCharge;
    }
    totalComplianceCharges += complianceData.otherCharges;

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
      otherCharges,
      insurance,
      addressFormId,
      boxes,
      parsedCarrier,
      parsedCompliance,
      pickupAddress,
      destinationAddress,
      products,
      packages,
      orderMeta,
      rawOrderData
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

    if (otherCharges < 0) {
      return res.status(400).json({ success: false, error: 'otherCharges must be a non-negative number' });
    }
    const invoiceValue = parseOptionalNumber(shipmentValue);
    if (insurance && (!invoiceValue || invoiceValue <= 0)) {
      return res.status(400).json({ success: false, error: 'shipmentValue is required when insurance is selected' });
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

    let {complianceData, totalComplianceCharges} = getComplianceData(parsedCompliance, {
      insurance,
      shipmentValue: invoiceValue,
      otherCharges
    });

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

      ratePerKg = getRatePerKg({
        carrierName: parsedCarrier.carrier || parsedCarrier.name || carrierName,
        pickupCountry,
        destinationCountry,
        actualWeight: declaredWeight,
        chargeableWeight: totalChargeableWeight,
        standardRatePerKg: ratePerKg,
        boxes
      });

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
      const insuranceCharge = complianceData.insuranceCharge || 0;
      const otherCharge = complianceData.otherCharges || 0;

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
          temporaryExportForRepairAndReturnCharge: Number(temporaryExportForRepairAndReturnCharge.toFixed(2)),
          insuranceCharge: Number(insuranceCharge.toFixed(2)),
          otherCharges: Number(otherCharge.toFixed(2))
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
      carrier: parsedCarrier,
      addresses: {
        pickup: pickupAddress,
        destination: destinationAddress
      },
      products,
      packages,
      orderMeta,
      submittedDetails: rawOrderData,
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
  const search = String(req.query.search || '').trim();
  const status = String(req.query.status || '').trim();
  const carrier = String(req.query.carrier || '').trim();
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

  const allowedSortFields = new Set(['created_at', 'awb_number', 'status']);
  const allowedSortOrders = new Set(['asc', 'desc']);

  if (!allowedSortFields.has(sortBy)) {
    return res.status(400).json({
      success: false,
      error: 'sortBy must be one of: created_at, awb_number, status'
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
    .from('orders')
    .select('*', { count: 'exact' })
    .eq('user_id', userId);

  if (search) {
    const escapedSearch = search.replace(/[%_,]/g, '\\$&');
    query = query.or(
      `awb_number.ilike.%${escapedSearch}%,status.ilike.%${escapedSearch}%`
    );
  }

  if (status) {
    query = query.ilike('status', status);
  }

  if (carrier) {
    query = query.filter('carrier->>name', 'ilike', carrier);
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
        carrier,
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
});

// Get orders for a specific user (admin or owner)
router.get('/orders/user/:userId', authenticateToken, async (req, res) => {
  const { userId } = req.params;
  const search = String(req.query.search || '').trim();
  const status = String(req.query.status || '').trim();
  const carrier = String(req.query.carrier || '').trim();
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

  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Access denied'
    });
  }

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

  const allowedSortFields = new Set(['created_at', 'awb_number', 'status']);
  const allowedSortOrders = new Set(['asc', 'desc']);

  if (!allowedSortFields.has(sortBy)) {
    return res.status(400).json({
      success: false,
      error: 'sortBy must be one of: created_at, awb_number, status'
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
    .from('orders')
    .select('*', { count: 'exact' })
    .eq('user_id', userId);

  if (search) {
    const escapedSearch = search.replace(/[%_,]/g, '\\$&');
    query = query.or(
      `awb_number.ilike.%${escapedSearch}%,status.ilike.%${escapedSearch}%`
    );
  }

  if (status) {
    query = query.ilike('status', status);
  }

  if (carrier) {
    query = query.filter('carrier->>name', 'ilike', carrier);
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
        carrier,
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
});

module.exports = router;

