const { upsConfig } = require('./config');
const { createShipment } = require('./client');
const { resolveCountryCode } = require('./rateService');

function getFirst(...values) { return values.find((v) => v !== undefined && v !== null && String(v).trim() !== ''); }

function shipmentValidationError(details) {
  const error = new Error('UPS shipment information is incomplete');
  error.statusCode = 400;
  error.code = 'UPS_SHIPMENT_VALIDATION_ERROR';
  error.details = details;
  return error;
}

function buildParty(address = {}, fallback = {}, country, postalCode, label) {
  const addressFields = address.address && typeof address.address === 'object' ? { ...address, ...address.address } : address;
  const contact = address.contact && typeof address.contact === 'object' ? address.contact : {};
  const streetLine = getFirst(addressFields.streetLine1, addressFields.addressLine1, addressFields.street, addressFields.line1);
  const city = getFirst(addressFields.city, addressFields.town);
  const phoneNumber = getFirst(contact.phone, contact.phoneNumber, addressFields.phone);
  const personName = getFirst(contact.name, addressFields.name, fallback.name, 'Shipping Contact');
  const companyName = getFirst(addressFields.companyName, addressFields.company, fallback.company, personName);
  const errors = [];
  if (!streetLine) errors.push(`${label} address street line is required for UPS shipment creation`);
  if (!city) errors.push(`${label} address city is required for UPS shipment creation`);
  if (!phoneNumber) errors.push(`${label} contact phone number is required for UPS shipment creation`);
  if (errors.length) throw shipmentValidationError(errors);

  return {
    contact: { personName: String(personName), companyName: String(companyName), phoneNumber: String(phoneNumber), ...(contact.email ? { emailAddress: String(contact.email) } : {}) },
    address: { streetLines: [String(streetLine)], city: String(city), postalCode: String(getFirst(addressFields.postalCode, postalCode)), countryCode: resolveCountryCode(getFirst(addressFields.countryCode, addressFields.country, country)) }
  };
}

function buildPackages(boxes) {
  return boxes.flatMap((box) => {
    const quantity = Number(box.quantity || 1);
    const item = {
      weight: { units: 'KG', value: Number(box.actualWeight || box.weight) },
      dimensions: { length: Math.round(Number(box.length)), width: Math.round(Number(box.breadth || box.width)), height: Math.round(Number(box.height)), units: 'CM' }
    };
    return Array.from({ length: quantity }, (_, i) => ({ ...item, sequenceNumber: i + 1 }));
  }).map((item, index) => ({ ...item, sequenceNumber: index + 1 }));
}

function toUPSShipmentPayload(order) {
  const shipper = buildParty(order.pickupAddress, order.user, order.pickupCountry, order.pickupPincode, 'Pickup');
  const recipient = buildParty(order.destinationAddress, {}, order.destinationCountry, order.destinationPincode, 'Destination');
  const requestedPackageLineItems = buildPackages(order.boxes);
  const errors = [];
  if (!requestedPackageLineItems.length) errors.push('At least one package with a positive weight is required');
  if (errors.length) throw shipmentValidationError(errors);

  const payload = {
    accountNumber: upsConfig.accountNumber,
    shipment: { shipper, recipient, packages: requestedPackageLineItems, serviceType: order.serviceType || upsConfig.defaultServiceType }
  };

  return payload;
}

function normalizeShipmentResponse(response) {
  const shipment = response.output?.shipment || response.shipment || {};
  return {
    transactionId: response.transactionId,
    trackingNumber: shipment.trackingNumber || shipment.tracking_id || null,
    serviceType: shipment.serviceType,
    shipDate: shipment.shipDate || null,
    label: shipment.label?.encodedLabel || shipment.label || null,
    labelFormat: shipment.label?.format || null,
    alerts: shipment.alerts || []
  };
}

async function createUPSShipment(order) {
  return normalizeShipmentResponse(await createShipment(toUPSShipmentPayload(order)));
}

module.exports = { createUPSShipment, toUPSShipmentPayload, normalizeShipmentResponse };
