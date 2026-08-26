const { upsConfig } = require('./config');
const { getRateQuote, validatePostalCode, getServiceAvailability } = require('./client');
const countryData = require('../data/countryCodes.json');

const COUNTRY_NAMES = Object.fromEntries(
  countryData.map((c) => [String(c.name || '').toLowerCase().replace(/[.,()]/g, '').replace(/\s+/g, ' '), c.code])
);

const ALIASES = Object.fromEntries([
  ['uae', 'AE'],
  ['uk', 'GB'],
  ['usa', 'US'],
  ['us', 'US']
]);

function countryCode(value) {
  const country = String(value || '').trim();
  const normalizedName = country.toLowerCase().replace(/[.,()]/g, '').replace(/\s+/g, ' ');
  if (ALIASES[normalizedName]) return ALIASES[normalizedName];
  if (COUNTRY_NAMES[normalizedName]) return COUNTRY_NAMES[normalizedName];
  return country.toUpperCase();
}

function asPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function validateRateInput(body = {}) {
  const shipper = body.shipper || {};
  const recipient = body.recipient || {};
  const packages = Array.isArray(body.packages) && body.packages.length ? body.packages : [body.package || body];
  const errors = [];

  for (const [label, party] of [['shipper', shipper], ['recipient', recipient]]) {
    if (!String(party.postalCode || '').trim()) errors.push(`${label}.postalCode is required`);
  }

  packages.forEach((item, index) => {
    if (!asPositiveNumber(item.weight)) errors.push(`packages[${index}].weight must be a positive number`);
  });

  if (errors.length) {
    const error = new Error('Invalid UPS rate request');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    error.details = errors;
    throw error;
  }

  return { shipper, recipient, packages };
}

function toUPSPayload(body) {
  const { shipper, recipient, packages } = validateRateInput(body);
  const requestedPackageLineItems = packages.map((item, index) => ({
    sequenceNumber: index + 1,
    weight: { units: String(item.weightUnit || 'KG').toUpperCase(), value: Number(item.weight) }
  }));

  const payload = {
    accountNumber: upsConfig.accountNumber,
    requestedShipment: {
      shipper: { address: { postalCode: String(shipper.postalCode).trim(), countryCode: countryCode(shipper.countryCode) } },
      recipient: { address: { postalCode: String(recipient.postalCode).trim(), countryCode: countryCode(recipient.countryCode) } },
      requestedPackageLineItems
    }
  };

  if (body.serviceType) payload.requestedShipment.serviceType = body.serviceType;
  return payload;
}

function normalizeRateResponse(response) {
  const quotes = (response.output?.quotes || response.quotes || [])
    .map((q) => ({
      serviceType: q.serviceType || q.code,
      serviceName: q.serviceName || q.description || q.serviceType,
      currency: q.currency || q.totalChargeCurrency || 'USD',
      totalNetCharge: Number(q.totalNetCharge || q.totalCharge || 0),
      totalBaseCharge: Number(q.baseCharge || 0),
      totalSurcharges: Number(q.totalSurcharges || 0),
      billingWeight: q.billingWeight || null,
      surcharges: q.surcharges || []
    }));

  return { transactionId: response.transactionId, alerts: response.output?.alerts || [], quotes };
}

async function calculateRates(body) {
  const payload = toUPSPayload(body);
  const response = await getRateQuote(payload);
  return normalizeRateResponse(response);
}

async function calculateValidatedRates(body) {
  const payload = toUPSPayload(body);
  const [origin, destination] = await Promise.all([
    validatePostalCode({ postalCode: payload.requestedShipment.shipper.address.postalCode, countryCode: payload.requestedShipment.shipper.address.countryCode }),
    validatePostalCode({ postalCode: payload.requestedShipment.recipient.address.postalCode, countryCode: payload.requestedShipment.recipient.address.countryCode })
  ]);
  const availability = await getServiceAvailability(payload);
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
    .map((box) => ({ weight: Number(box.actualWeight || box.weight), quantity: Number(box.quantity || 1) }));

  return {
    shipper: { countryCode: input.pickupCountry, postalCode: input.pickupPincode },
    recipient: { countryCode: input.destinationCountry, postalCode: input.destinationPincode },
    packages: packages.length ? packages : [{ weight: input.weight }],
    serviceType: input.serviceType || input.carrier?.serviceType
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
  toUPSPayload,
  normalizeRateResponse,
  resolveCountryCode: countryCode
};
