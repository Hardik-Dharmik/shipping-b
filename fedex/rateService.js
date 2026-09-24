const { fedexConfig } = require('./config');
const { getRateQuote, validatePostalCode, getServiceAvailability } = require('./client');

const COUNTRY_CODE = /^[A-Z]{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

// Use the comprehensive country list from data/countryCodes.json to
// resolve full country names to their two-letter ISO codes. Include
// some common short-name aliases (e.g. UAE, UK, USA) for convenience
// because users often submit these.
const countryData = require('../data/countryCodes.json');
const COUNTRY_NAMES = Object.fromEntries(
  countryData.map((c) => [String(c.name || '').toLowerCase().replace(/[.,()]/g, '').replace(/\s+/g, ' '), c.code])
);

const ALIASES = Object.fromEntries([
  ['uae', 'AE'],
  ['u.a.e.', 'AE'],
  ['uk', 'GB'],
  ['united kingdom', 'GB'],
  ['great britain', 'GB'],
  ['gb', 'GB'],
  ['usa', 'US'],
  ['us', 'US'],
  ['u.s.a.', 'US'],
  ['america', 'US'],
  ['saudi', 'SA'],
  ['ksa', 'SA']
]);

function asPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function countryCode(value) {
  const country = String(value || '').trim();
  const normalizedName = country.toLowerCase().replace(/[.,()]/g, '').replace(/\s+/g, ' ');
  if (ALIASES[normalizedName]) return ALIASES[normalizedName];
  if (COUNTRY_NAMES[normalizedName]) return COUNTRY_NAMES[normalizedName];
  return country.toUpperCase();
}

function optionalAddress(address = {}) {
  const result = {};
  if (address.city) result.city = String(address.city).trim();
  if (address.stateOrProvinceCode) result.stateOrProvinceCode = String(address.stateOrProvinceCode).trim();
  return result;
}

function rateAddress(party = {}) {
  const address = { countryCode: countryCode(party.countryCode), ...optionalAddress(party) };
  const postalCode = String(party.postalCode || '').trim();
  // Older calculator clients put the UAE city in the pincode field.
  if (address.countryCode === 'AE' && /\p{L}/u.test(postalCode) && !/\d/.test(postalCode)) {
    if (!address.city) address.city = postalCode;
  } else if (postalCode) {
    address.postalCode = postalCode;
  }
  // FedEx rate validation requires a non-null postal code even for UAE.
  // Only supply the non-postal-country placeholder when a city is known.
  if (address.countryCode === 'AE' && address.city && !address.postalCode) {
    address.postalCode = '00000';
  }
  return address;
}

function currentShipDate() {
  return new Date().toISOString().slice(0, 10);
}

function transitDays(commit = {}) {
  const numericDays = Number(commit.transitDays);
  if (Number.isFinite(numericDays)) return numericDays;

  const words = {
    ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
    SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10
  };
  const match = String(commit.transitTime || '').toUpperCase().match(/(ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN)/);
  return match ? words[match[1]] : null;
}

function validateRateInput(body = {}) {
  const shipper = rateAddress(body.shipper || {});
  const recipient = rateAddress(body.recipient || {});
  const packages = Array.isArray(body.packages) && body.packages.length
    ? body.packages
    : [body.package || body];
  const errors = [];

  for (const [label, party] of [['shipper', shipper], ['recipient', recipient]]) {
    if (!COUNTRY_CODE.test(countryCode(party.countryCode))) {
      errors.push(`${label}.countryCode must be a two-letter ISO country code`);
    }
    if (!party.postalCode && !(party.countryCode === 'AE' && party.city)) {
      errors.push(party.countryCode === 'AE'
        ? `${label}.city or postalCode is required for UAE`
        : `${label}.postalCode is required`);
    }
  }

  if (packages.length > 25) errors.push('FedEx supports a maximum of 25 packages per rate request');
  packages.forEach((item, index) => {
    if (!asPositiveNumber(item.weight)) errors.push(`packages[${index}].weight must be a positive number`);
    const dimensions = item.dimensions;
    if (dimensions !== undefined && (
      !asPositiveNumber(dimensions.length) ||
      !asPositiveNumber(dimensions.width) ||
      !asPositiveNumber(dimensions.height)
    )) errors.push(`packages[${index}].dimensions must include positive length, width, and height`);
  });

  const originCountry = countryCode(shipper.countryCode);
  const destinationCountry = countryCode(recipient.countryCode);
  if (COUNTRY_CODE.test(originCountry) && COUNTRY_CODE.test(destinationCountry) && originCountry !== destinationCountry) {
    const shipmentValue = Number(body.shipmentValue);
    if (!Number.isFinite(shipmentValue) || shipmentValue <= 0) {
      errors.push('shipmentValue must be a positive number for an international FedEx rate quote');
    }
  }

  if (errors.length) {
    const error = new Error('Invalid FedEx rate request');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    error.details = errors;
    throw error;
  }

  return { shipper, recipient, packages };
}

function toFedExPayload(body) {
  const { shipper, recipient, packages } = validateRateInput(body);
  const shipmentCurrency = String(body.currency || 'USD').toUpperCase();
  const requestedPackageLineItems = packages.map((item, index) => {
    const lineItem = {
      sequenceNumber: index + 1,
      groupPackageCount: Number(item.quantity || 1),
      weight: { units: String(item.weightUnit || 'KG').toUpperCase(), value: Number(item.weight) }
    };
    if (item.dimensions) {
      lineItem.dimensions = {
        length: Math.round(Number(item.dimensions.length)),
        width: Math.round(Number(item.dimensions.width)),
        height: Math.round(Number(item.dimensions.height)),
        units: String(item.dimensions.unit || 'CM').toUpperCase()
      };
    }
    return lineItem;
  });

  const payload = {
    accountNumber: { value: fedexConfig.accountNumber },
    returnTransitTimes: body.returnTransitTimes !== false,
    requestedShipment: {
      shipper: {
        address: shipper
      },
      recipient: {
        address: recipient
      },
      pickupType: body.pickupType || 'USE_SCHEDULED_PICKUP',
      shipDateStamp: body.shipDateStamp || currentShipDate(),
      rateRequestType: Array.isArray(body.rateRequestType) ? body.rateRequestType : ['ACCOUNT'],
      requestedPackageLineItems
    },
  };

  if (body.serviceType) payload.requestedShipment.serviceType = body.serviceType;
  payload.requestedShipment.packagingType = body.packagingType || 'YOUR_PACKAGING';
  if (body.includePickupRates) payload.processingOptions = ['INCLUDE_PICKUPRATES'];
  if (CURRENCY_CODE.test(shipmentCurrency)) {
    payload.requestedShipment.preferredCurrency = shipmentCurrency;
    payload.requestedShipment.rateRequestType = [...new Set([
      ...payload.requestedShipment.rateRequestType, 'PREFERRED'
    ])];
  }

  const originCountry = countryCode(shipper.countryCode);
  const destinationCountry = countryCode(recipient.countryCode);
  if (originCountry !== destinationCountry) {
    const shipmentValue = Number(body.shipmentValue);
    const totalWeight = packages.reduce(
      (total, item) => total + (Number(item.weight) * Number(item.quantity || 1)),
      0
    );
    const commodity = {
      description: String(body.commodityDescription || 'Shipment contents'),
      name: String(body.commodityDescription || 'Shipment contents'),
      quantity: 1,
      quantityUnits: 'PCS',
      numberOfPieces: 1,
      countryOfManufacture: originCountry,
      weight: { units: String(body.weightUnit || 'KG').toUpperCase(), value: totalWeight },
      unitPrice: { amount: shipmentValue, currency: shipmentCurrency },
      customsValue: { amount: shipmentValue, currency: shipmentCurrency }
    };
    payload.requestedShipment.customsClearanceDetail = {
      dutiesPayment: {
        paymentType: 'SENDER',
        payor: { responsibleParty: { accountNumber: { value: fedexConfig.accountNumber } } }
      },
      commodities: [commodity]
    };
  }
  return payload;
}

function normalizeRateResponse(response) {
  const rateReplyDetails = response.output?.rateReplyDetails || [];
  return {
    transactionId: response.transactionId,
    alerts: response.output?.alerts || [],
    quotes: rateReplyDetails.map((detail) => {
      const ratedShipment = detail.ratedShipmentDetails?.find(
        (item) => item.rateType === 'PREFERRED' || item.rateType === 'PAYOR_PREFERRED_PACKAGE' || item.rateType === 'PAYOR_PREFERRED_SHIPMENT'
      ) || detail.ratedShipmentDetails?.find(
        (item) => item.rateType === 'ACCOUNT' || item.rateType === 'PAYOR_ACCOUNT_PACKAGE'
      ) || detail.ratedShipmentDetails?.[0] || {};
      const shipmentRateDetail = ratedShipment.shipmentRateDetail || {};
      const ratedPackage = ratedShipment.ratedPackages?.[0]?.packageRateDetail || {};
      const serviceName = detail.serviceDescription?.names?.find(
        (name) => name.type === 'long' && name.encoding === 'ascii'
      )?.value || detail.serviceName?.replace(/Â®/g, '') || detail.serviceType;
      const surcharges = shipmentRateDetail.surCharges || shipmentRateDetail.surcharges || ratedPackage.surcharges || [];
      const billingWeight = shipmentRateDetail.totalBillingWeight || ratedPackage.billingWeight || null;
      const commit = detail.commit || {};
      const dateDetail = commit.dateDetail || {};

      return {
        serviceType: detail.serviceType,
        serviceName,
        packagingType: detail.packagingType,
        currency: ratedShipment.currency || shipmentRateDetail.currency || ratedPackage.currency,
        totalNetCharge: Number(ratedShipment.totalNetCharge || 0),
        totalBaseCharge: Number(ratedShipment.totalBaseCharge || 0),
        totalSurcharges: Number(shipmentRateDetail.totalSurcharges || ratedPackage.totalSurcharges || 0),
        billingWeight: billingWeight
          ? { value: Number(billingWeight.value), unit: billingWeight.units }
          : null,
        surcharges: surcharges.map((item) => ({
          type: item.type || item.surchargeType,
          description: item.description,
          level: item.level,
          amount: Number(item.amount || 0)
        })),
        customerMessages: detail.customerMessages || [],
        estimatedDeliveryDays: transitDays(commit),
        deliveryTimestamp: dateDetail.dayFormat || dateDetail.date || null,
        transitTime: commit.transitTime || null,
        deliveryDay: dateDetail.dayOfWeek || null,
        deliveryMessage: commit.label || commit.commitMessageDetails || null
      };
    })
  };
}

async function calculateRates(body) {
  const payload = toFedExPayload(body);
  const response = await getRateQuote(payload);
  return normalizeRateResponse(response);
}

function postalPayload(address) {
  return {
    carrierCode: 'FDXE',
    countryCode: address.countryCode,
    postalCode: address.postalCode,
    shipDate: currentShipDate()
  };
}

function serviceAvailabilityPayload(ratePayload) {
  const shipment = ratePayload.requestedShipment;
  return {
    accountNumber: ratePayload.accountNumber,
    carrierCodes: ['FDXE'],
    requestedShipment: {
      shipDatestamp: shipment.shipDateStamp,
      pickupType: shipment.pickupType,
      packagingType: shipment.packagingType || 'YOUR_PACKAGING',
      shipper: shipment.shipper,
      recipients: [{ address: shipment.recipient.address }],
      requestedPackageLineItems: shipment.requestedPackageLineItems,
      ...(shipment.customsClearanceDetail ? { customsClearanceDetail: shipment.customsClearanceDetail } : {})
    }
  };
}

async function calculateValidatedRates(body) {
  const payload = toFedExPayload(body);
  const validateAddress = (address) => address.countryCode === 'AE'
    ? Promise.resolve({ skipped: true, reason: 'UAE addresses do not require postal-code validation' })
    : validatePostalCode(postalPayload(address));
  const [origin, destination] = await Promise.all([
    validateAddress(payload.requestedShipment.shipper.address),
    validateAddress(payload.requestedShipment.recipient.address)
  ]);
  const availability = await getServiceAvailability(serviceAvailabilityPayload(payload));
  const rates = await getRateQuote(payload);
  return {
    ...normalizeRateResponse(rates),
    validation: { origin: origin.output || origin, destination: destination.output || destination },
    serviceAvailability: availability.output || availability
  };
}

function toCalculatorRateRequest(input) {
  const boxes = Array.isArray(input.boxes) ? input.boxes : [];
  const packages = boxes
    .filter((box) => asPositiveNumber(box.actualWeight || box.weight))
    .map((box) => ({
      weight: Number(box.actualWeight || box.weight),
      quantity: Number(box.quantity || 1),
      dimensions: box.length && (box.breadth || box.width) && box.height
        ? {
            length: Number(box.length),
            width: Number(box.breadth || box.width),
            height: Number(box.height),
            unit: 'CM'
          }
        : undefined
    }));

  return {
    shipper: {
      countryCode: input.pickupCountry,
      postalCode: input.pickupPincode,
      city: input.pickupCity || input.pickupAddress?.city
    },
    recipient: {
      countryCode: input.destinationCountry,
      postalCode: input.destinationPincode,
      city: input.destinationCity || input.destinationAddress?.city
    },
    packages: packages.length ? packages : [{
      weight: input.weight,
      dimensions: input.dimensions
        ? {
            length: input.dimensions.length,
            width: input.dimensions.breadth || input.dimensions.width,
            height: input.dimensions.height,
            unit: 'CM'
          }
        : undefined
    }],
    shipmentValue: input.shipmentValue,
    currency: input.currency || 'AED',
    commodityDescription: input.commodityDescription || input.products?.[0]?.description || input.products?.[0]?.name,
    serviceType: input.serviceType || input.carrier?.serviceType,
    packagingType: input.packagingType || input.carrier?.packagingType,
    rateRequestType: input.rateRequestType,
    shipDateStamp: input.shipDateStamp,
    returnTransitTimes: input.returnTransitTimes !== false
  };
}

async function calculateCalculatorRates(input) {
  return calculateRates(toCalculatorRateRequest(input));
}

async function calculateValidatedCalculatorRates(input) {
  return calculateValidatedRates(toCalculatorRateRequest(input));
}

module.exports = {
  calculateRates,
  calculateCalculatorRates,
  calculateValidatedCalculatorRates,
  toCalculatorRateRequest,
  toFedExPayload,
  serviceAvailabilityPayload,
  normalizeRateResponse,
  resolveCountryCode: countryCode
};
