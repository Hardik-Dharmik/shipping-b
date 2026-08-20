const { fedexConfig } = require('./config');
const { createPickup, cancelPickup, getPickupAvailability } = require('./client');
const { resolveCountryCode } = require('./rateService');
const { buildParty } = require('./shipmentService');

function pickupValidationError(details) {
  const error = new Error('FedEx pickup information is incomplete');
  error.statusCode = 400;
  error.code = 'FEDEX_PICKUP_VALIDATION_ERROR';
  error.details = details;
  return error;
}

function asDate(value, field, errors) {
  const date = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    errors.push(`${field} must be an ISO date (YYYY-MM-DD)`);
  }
  return date;
}

function time(value, fallback, field, errors) {
  const result = String(value || fallback);
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(result)) errors.push(`${field} must be HH:mm or HH:mm:ss`);
  return result.length === 5 ? `${result}:00` : result;
}

function buildPickupPayload(input, user = {}) {
  const errors = [];
  const pickupDate = asDate(input.pickupDate || input.scheduledDate, 'pickupDate', errors);
  const readyTime = time(input.readyTime, '09:00', 'readyTime', errors);
  const closeTime = time(input.customerCloseTime || input.closeTime, '17:00', 'customerCloseTime', errors);
  const packageCount = Number(input.packageCount || 1);
  const totalWeight = Number(input.totalWeight || input.weight);
  const carrierCode = String(input.carrierCode || 'FDXE').toUpperCase();
  const countryCode = resolveCountryCode(input.pickupCountry || input.countryCode || input.pickupAddress?.countryCode || input.pickupAddress?.country);

  if (!['FDXE', 'FDXG'].includes(carrierCode)) errors.push('carrierCode must be FDXE or FDXG');
  if (!Number.isInteger(packageCount) || packageCount < 1 || packageCount > 99) errors.push('packageCount must be an integer from 1 to 99');
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) errors.push('totalWeight must be a positive number');
  if (!countryCode) errors.push('pickupCountry is required');
  if (errors.length) throw pickupValidationError(errors);

  const pickupLocation = buildParty(input.pickupAddress, user, countryCode, input.pickupPincode, 'Pickup');
  const accountAddressOfRecord = pickupLocation.address;
  const readyDateTimestamp = input.readyDateTimestamp || `${pickupDate}T${readyTime}`;

  return {
    associatedAccountNumber: { value: fedexConfig.accountNumber },
    originDetail: {
      pickupLocation,
      readyDateTimestamp,
      customerCloseTime: closeTime,
      pickupDate,
      packageLocation: input.packageLocation || 'FRONT',
      ...(input.buildingPart ? { buildingPart: input.buildingPart } : {}),
      ...(input.buildingPartDescription ? { buildingPartDescription: input.buildingPartDescription } : {})
    },
    pickupType: input.pickupType || 'ON_CALL',
    carrierCode,
    countryCode,
    packageCount,
    totalWeight: { units: String(input.weightUnits || 'KG').toUpperCase(), value: totalWeight },
    ...(input.remarks ? { remarks: String(input.remarks) } : {}),
    ...(Array.isArray(input.trackingNumbers) && input.trackingNumbers.length ? { trackingNumbers: input.trackingNumbers.map(String) } : {}),
    // Persisted as supplied so FedEx can match the cancellation request exactly.
    _local: { accountAddressOfRecord, scheduledDate: pickupDate }
  };
}

function toFedExCreatePayload(payload) {
  const { _local, ...fedexPayload } = payload;
  return fedexPayload;
}

function normalizePickupResponse(response, fallback = {}) {
  const output = response.output || {};
  return {
    transactionId: response.transactionId,
    confirmationCode: output.pickupConfirmationCode || output.confirmationCode || response.pickupConfirmationCode,
    location: output.location || response.location || null,
    scheduledDate: output.pickupDate || fallback.scheduledDate,
    alerts: output.alerts || response.alerts || []
  };
}

async function scheduleFedExPickup(input, user) {
  const payload = buildPickupPayload(input, user);
  const fedexPayload = toFedExCreatePayload(payload);
  console.info('FedEx pickup create payload', fedexPayload);
  const response = await createPickup(fedexPayload);
  const pickup = normalizePickupResponse(response, payload._local);
  if (!pickup.confirmationCode) {
    const error = new Error('FedEx did not return a pickup confirmation code');
    error.statusCode = 502;
    error.code = 'FEDEX_INVALID_PICKUP_RESPONSE';
    throw error;
  }
  return { ...pickup, request: payload };
}

async function cancelFedExPickup(pickup) {
  const request = pickup.request_data || pickup.request || {};
  const local = request._local || {};
  const payload = {
    associatedAccountNumber: { value: fedexConfig.accountNumber },
    pickupConfirmationCode: pickup.carrier_confirmation_code,
    carrierCode: request.carrierCode,
    scheduledDate: pickup.scheduled_date || local.scheduledDate,
    ...(pickup.carrier_location_code ? { location: pickup.carrier_location_code } : {}),
    ...(local.accountAddressOfRecord ? { accountAddressOfRecord: local.accountAddressOfRecord } : {}),
    ...(request.remarks ? { remarks: request.remarks } : {})
  };
  return cancelPickup(payload);
}

async function checkFedExPickupAvailability(payload) {
  return getPickupAvailability(payload);
}

module.exports = { scheduleFedExPickup, cancelFedExPickup, checkFedExPickupAvailability, buildPickupPayload };
