const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');
const { calculateValidatedCalculatorRates: calculateFedExRates } = require('../fedex/rateService');
const { calculateValidatedCalculatorRates: calculateUPSRates } = require('../ups/rateService');
const { createFedExShipment } = require('../fedex/shipmentService');
const { createUPSShipment } = require('../ups/shipmentService');
const { scheduleFedExPickup } = require('../fedex/pickupService');



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

// Keep the UI vocabulary in one place.  `serviceType` is the value sent to the
// carrier APIs; the display names can safely be shown on the link-creation page.
const SHIPPING_SERVICES = [
  { carrier: 'FedEx', shipmentType: 'box', serviceType: 'INTERNATIONAL_ECONOMY', name: 'FedEx International Economy' },
  { carrier: 'FedEx', shipmentType: 'box', serviceType: 'INTERNATIONAL_PRIORITY', name: 'FedEx International Priority' },
  { carrier: 'FedEx', shipmentType: 'box', serviceType: 'FEDEX_REGIONAL_ECONOMY', name: 'FedEx Regional Economy', roadOnly: true },
  { carrier: 'FedEx', shipmentType: 'freight', serviceType: 'INTERNATIONAL_ECONOMY_FREIGHT', name: 'FedEx International Economy Freight' },
  { carrier: 'FedEx', shipmentType: 'freight', serviceType: 'FEDEX_INTERNATIONAL_PRIORITY_FREIGHT', name: 'FedEx International Priority Freight' },
  { carrier: 'FedEx', shipmentType: 'freight', serviceType: 'FEDEX_REGIONAL_ECONOMY_FREIGHT', name: 'FedEx Regional Freight', roadOnly: true },
  { carrier: 'UPS', shipmentType: 'box', serviceType: 'UPS_SAVER', name: 'UPS Saver' },
  { carrier: 'UPS', shipmentType: 'box', serviceType: 'UPS_EXPEDITED', name: 'UPS Expedited' },
  { carrier: 'UPS', shipmentType: 'pallet', serviceType: 'WORLDWIDE_EXPRESS_FREIGHT', name: 'Worldwide Express Freight' }
];

const normalizeLocation = (country, pincode, label) => {
  const normalizedCountry = String(country || '').trim();
  const normalizedPincode = String(pincode || '').trim();
  if (!normalizedCountry || !normalizedPincode) {
    const error = new Error(`${label} country and pincode are required`);
    error.statusCode = 400;
    throw error;
  }
  return { country: normalizedCountry, pincode: normalizedPincode };
};

const selectedService = (draft) => {
  const carrier = draft?.carrier || {};
  const carrierName = String(carrier.carrier || carrier.name || draft?.carrierName || '').trim().toLowerCase();
  const legacyServiceTypes = {
    FEDEX_INTERNATIONAL_ECONOMY: 'INTERNATIONAL_ECONOMY',
    FEDEX_INTERNATIONAL_ECONOMY_FREIGHT: 'INTERNATIONAL_ECONOMY_FREIGHT'
  };
  const requestedServiceType = String(carrier.serviceType || draft?.serviceType || '').trim().toUpperCase();
  const serviceType = legacyServiceTypes[requestedServiceType] || requestedServiceType;
  const service = SHIPPING_SERVICES.find((item) => item.carrier.toLowerCase() === carrierName && item.serviceType === serviceType);
  if (!service) {
    const error = new Error('Select one of the supported FedEx or UPS services before creating a link');
    error.statusCode = 400;
    throw error;
  }
  return service;
};

const buildRateInput = (draft, locations, service) => ({
  ...draft,
  pickupCountry: locations.pickup.country,
  pickupPincode: locations.pickup.pincode,
  destinationCountry: locations.destination.country,
  destinationPincode: locations.destination.pincode,
  carrier: { ...(draft.carrier || {}), carrier: service.carrier, name: service.carrier, serviceType: service.serviceType },
  serviceType: service.serviceType
});

// A rate for the exact service is the carrier's final availability decision for
// the supplied country/postcode, including road-only regional products.
const verifySelectedService = async (draft, locations) => {
  const service = selectedService(draft);
  const input = buildRateInput(draft, locations, service);
  const response = service.carrier === 'FedEx'
    ? await calculateFedExRates(input)
    : await calculateUPSRates(input);
  const quote = (response.quotes || []).find((item) => String(item.serviceType || '').toUpperCase() === service.serviceType);
  if (!quote) {
    const error = new Error(`${service.name} is not available for the selected pickup and destination country/postcode`);
    error.statusCode = 422;
    throw error;
  }
  return { service, quote };
};

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

  const carrier = draft.carrier && typeof draft.carrier === 'object' ? draft.carrier : null;
  const carrierName = String(carrier?.carrier || carrier?.name || '').toLowerCase();
  if (!carrier || !['fedex', 'ups'].includes(carrierName)) {
    throw new Error('The saved order link does not contain a supported carrier service');
  }

  const { data: user, error: userError } = await supabaseAdmin
    .from('users')
    .select('id, name, email, company_name')
    .eq('id', form.user_id)
    .single();
  if (userError) throw userError;

  // Creating the actual carrier shipment here makes the number returned to the
  // recipient a carrier AWB, rather than a locally generated placeholder.
  const shipmentRequest = {
    ...draft,
    user,
    pickupCountry: pickup.country,
    pickupPincode: pickup.pincode,
    destinationCountry: destination.country,
    destinationPincode: destination.pincode,
    pickupAddress,
    destinationAddress,
    serviceType: carrier.serviceType
  };
  const shipment = carrierName === 'fedex'
    ? await createFedExShipment(shipmentRequest)
    : await createUPSShipment(shipmentRequest);
  const awbNumber = shipment.trackingNumber;
  if (!awbNumber) throw new Error(`${carrierName === 'fedex' ? 'FedEx' : 'UPS'} did not return an AWB number`);

  // Keep the payload shape identical to /api/shipping/order so existing order
  // list and detail screens can render costs, declared weight and shipment value.
  const processedBoxes = boxes.map((box, index) => {
    const quantity = Number(box.quantity || 0);
    const itemWeight = Number(box.actualWeight || box.weight || 0);
    const length = Number(box.length || 0);
    const breadth = Number(box.breadth || box.width || 0);
    const height = Number(box.height || 0);
    if (!quantity || !itemWeight || !length || !breadth || !height) throw new Error(`Invalid box at index ${index}`);
    const volumetricWeight = (length * breadth * height) / 5000;
    return {
      quantity,
      actualWeight: itemWeight,
      dimensions: { length, breadth, height, unit: 'cm' },
      volumetricWeight: Number(volumetricWeight.toFixed(2)),
      chargeableWeight: Number(Math.max(itemWeight, volumetricWeight).toFixed(2))
    };
  });
  const totalChargeableWeight = processedBoxes.reduce(
    (total, box) => total + (box.chargeableWeight * box.quantity), 0
  );
  const savedQuote = draft.selectedServiceQuote || {};
  const quoteCost = Number(savedQuote.totalNetCharge || savedQuote.totalCharge || 0);
  const normalizedCarrier = {
    ...carrier,
    trackingNumber: awbNumber,
    currency: carrier.currency || savedQuote.currency || draft.currency || 'AED',
    ...(Number.isFinite(quoteCost) && quoteCost > 0 ? {
      cost: quoteCost,
      costBreakdown: {
        weight: actualWeight,
        baseShippingCost: quoteCost,
        additionalCharges: 0,
        totalCost: quoteCost,
        currency: carrier.currency || savedQuote.currency || draft.currency || 'AED'
      }
    } : {}),
    carrierShipment: {
      transactionId: shipment.transactionId,
      serviceType: shipment.serviceType || carrier.serviceType,
      shipDate: shipment.shipDate || null
    }
  };
  const pickupRequest = draft.pickupRequest || draft.schedulePickup || null;
  let scheduledPickup = null;
  if (pickupRequest) {
    if (carrierName !== 'fedex') {
      const error = new Error('Pickup scheduling is currently available only for FedEx orders');
      error.statusCode = 400;
      throw error;
    }
    const alternatePickupAddress = String(pickupRequest.alternatePickupAddress || '').trim();
    const pickupAddressForSchedule = pickupRequest.pickupAddress || (alternatePickupAddress
      ? {
        ...pickupAddress,
        streetLine1: alternatePickupAddress,
        ...(pickupAddress?.address && typeof pickupAddress.address === 'object'
          ? { address: { ...pickupAddress.address, streetLine1: alternatePickupAddress } }
          : {})
      }
      : pickupAddress);
    scheduledPickup = await scheduleFedExPickup({
      ...pickupRequest,
      pickupCountry: pickupRequest.pickupCountry || pickup.country,
      pickupPincode: pickupRequest.pickupPincode || pickup.pincode,
      pickupAddress: pickupAddressForSchedule,
      packageCount: pickupRequest.packageCount || processedBoxes.reduce((total, box) => total + box.quantity, 0),
      totalWeight: pickupRequest.totalWeight || totalChargeableWeight,
      trackingNumbers: pickupRequest.trackingNumbers || [awbNumber]
    }, user);
  }
  const shipmentValue = Number(draft.shipmentValue);
  const orderData = {
    ...draft,
    orderId: `ORD-${Date.now()}`,
    user: { id: form.user_id },
    pickup: { country: pickup.country, pincode: pickup.pincode },
    destination: { country: destination.country, pincode: destination.pincode },
    compliance: draft.compliance || {},
    weight: {
      declared: actualWeight,
      chargeable: Number(totalChargeableWeight.toFixed(2)),
      unit: 'kg'
    },
    boxes: processedBoxes,
    shipmentValue: Number.isFinite(shipmentValue) && shipmentValue > 0
      ? { value: shipmentValue, currency: draft.currency || normalizedCarrier.currency }
      : null,
    carrier: normalizedCarrier,
    addresses: { pickup: pickupAddress, destination: destinationAddress },
    products: Array.isArray(draft.products) ? draft.products : [],
    packages: Array.isArray(draft.packages) ? draft.packages : [],
    awb_number: awbNumber,
    carrier_shipment: normalizedCarrier.carrierShipment,
    ...(scheduledPickup ? {
      fedex_pickup: {
        confirmationCode: scheduledPickup.confirmationCode,
        location: scheduledPickup.location,
        scheduledDate: scheduledPickup.scheduledDate,
        status: 'SCHEDULED'
      }
    } : {}),
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
      carrier: normalizedCarrier,
      status: 'CREATED'
    })
    .select()
    .single();

  if (error) throw error;
  if (scheduledPickup) {
    const { error: pickupError } = await supabaseAdmin.from('pickups').insert({
      user_id: form.user_id,
      order_id: order.id,
      awb_number: awbNumber,
      carrier: 'FedEx',
      carrier_confirmation_code: scheduledPickup.confirmationCode,
      carrier_location_code: scheduledPickup.location,
      scheduled_date: scheduledPickup.scheduledDate,
      request_data: scheduledPickup.request,
      carrier_transaction_id: scheduledPickup.transactionId
    });
    if (pickupError) throw pickupError;
  }
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
    // Only the location constraint belongs to the creator.  Street/contact
    // details are deliberately collected from the recipient via the link.
    if (orderData.pickupAddress || orderData.sourceAddress || orderData.destinationAddress) {
      return res.status(400).json({ success: false, error: 'Do not include pickup or destination street-address details in an order-link draft' });
    }
    if (!Number.isFinite(Number(orderData.actualWeight)) || Number(orderData.actualWeight) <= 0) {
      return res.status(400).json({ success: false, error: 'actualWeight must be a positive number' });
    }
    if (!Array.isArray(orderData.boxes) || orderData.boxes.length === 0) {
      return res.status(400).json({ success: false, error: 'boxes must be a non-empty array' });
    }

    const locations = {
      pickup: normalizeLocation(orderData.pickupCountry || orderData.sourceCountry, orderData.pickupPincode || orderData.sourcePincode, 'Pickup'),
      destination: normalizeLocation(orderData.destinationCountry, orderData.destinationPincode, 'Destination')
    };
    const { service, quote } = await verifySelectedService(orderData, locations);
    const savedDraft = {
      ...buildRateInput(orderData, locations, service),
      // Preserve the quote used to validate availability; it is useful for
      // audit/display, but the final order pricing is still recalculated.
      selectedServiceQuote: quote
    };

    let inserted = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const { data, error } = await supabaseAdmin
        .from('order_address_forms')
        .insert({ user_id: req.user.id, code: generate6DigitCode(), form_type: 'order', order_data: savedDraft })
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
      message: 'Order address link generated and selected service verified',
      data: { ...inserted, selected_service: service, public_link: `${frontendBase}/address-form/${inserted.code}` }
    });
  } catch (error) {
    console.error('Create order address link error:', error);
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

// New-page data source. The recipient does not use this endpoint; it prevents
// the service list from being duplicated or silently drifting in the frontend.
router.get('/address-forms/services', authenticateToken, (req, res) => {
  res.json({ success: true, data: SHIPPING_SERVICES });
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
    // Do not expose commercial/order fields. Country and postcode are the
    // intentional exception: they must be displayed read-only to the recipient.
    if (data.form_type === 'order') {
      const draft = data.order_data || {};
      responseData.locked_addresses = {
        pickup: { country: draft.pickupCountry, pincode: draft.pickupPincode },
        destination: { country: draft.destinationCountry, pincode: draft.destinationPincode }
      };
      responseData.pickup_details = draft.pickupRequest || draft.schedulePickup || null;
      responseData.service = draft.carrier ? {
        carrier: draft.carrier.carrier || draft.carrier.name,
        serviceType: draft.carrier.serviceType
      } : null;
    }
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
    let pickupAddress = parseJsonField(req.body?.pickupAddress ?? req.body?.sourceAddress, null);
    let destinationAddress = parseJsonField(req.body?.destinationAddress, null);
    const products = parseJsonField(req.body?.products, []);
    const pickupRequest = parseJsonField(req.body?.pickupRequest ?? req.body?.schedulePickup, null);

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
      const draft = form.order_data || {};
      const lockedPickup = normalizeLocation(draft.pickupCountry, draft.pickupPincode, 'Saved pickup');
      const lockedDestination = normalizeLocation(draft.destinationCountry, draft.destinationPincode, 'Saved destination');
      // Ignore any attempt to substitute a location supplied in the public form.
      pickupAddress = { ...pickupAddress, country: lockedPickup.country, pincode: lockedPickup.pincode };
      destinationAddress = { ...destinationAddress, country: lockedDestination.country, pincode: lockedDestination.pincode };
      const completedDraft = { ...draft, pickupRequest: pickupRequest || draft.pickupRequest || draft.schedulePickup || null };
      // Claim the form before creating its order so a repeated click cannot issue
      // two AWBs. A claimed form is also protected by the existing submitted check.
      const { data: claimed, error: claimError } = await supabaseAdmin
        .from('order_address_forms')
        .update({ is_submitted: true, submitted_at: new Date().toISOString(), pickup_address: pickupAddress, destination_address: destinationAddress, order_data: completedDraft })
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

