const { fedexConfig } = require('./config');
const { createShipment } = require('./client');
const { resolveCountryCode } = require('./rateService');

const getFirst = (...values) => values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');

// These are the four Section II battery types shown by FedEx Ship Manager.
// They do not cover standalone batteries or lithium shipments that need a full
// Dangerous Goods Shipper's Declaration.
const LITHIUM_BATTERY_TYPES = {
  LITHIUM_METAL_CONTAINED_IN_EQUIPMENT: {
    label: 'Metal contained in equipment (UN3091, PI970)',
    batteryMaterialType: 'LITHIUM_METAL',
    batteryPackingType: 'CONTAINED_IN_EQUIPMENT'
  },
  LITHIUM_METAL_PACKED_WITH_EQUIPMENT: {
    label: 'Metal packed with equipment (UN3091, PI969)',
    batteryMaterialType: 'LITHIUM_METAL',
    batteryPackingType: 'PACKED_WITH_EQUIPMENT'
  },
  LITHIUM_ION_CONTAINED_IN_EQUIPMENT: {
    label: 'Ion contained in equipment (UN3481, PI967)',
    batteryMaterialType: 'LITHIUM_ION',
    batteryPackingType: 'CONTAINED_IN_EQUIPMENT'
  },
  LITHIUM_ION_PACKED_WITH_EQUIPMENT: {
    label: 'Ion packed with equipment (UN3481, PI966)',
    batteryMaterialType: 'LITHIUM_ION',
    batteryPackingType: 'PACKED_WITH_EQUIPMENT'
  }
};

function asStringArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function shipmentValidationError(details) {
  const error = new Error('FedEx shipment information is incomplete');
  error.statusCode = 400;
  error.code = 'FEDEX_SHIPMENT_VALIDATION_ERROR';
  error.details = details;
  return error;
}

function buildParty(address = {}, fallback = {}, country, postalCode, label) {
  const addressFields = address.address && typeof address.address === 'object'
    ? { ...address, ...address.address }
    : address;
  const contact = address.contact && typeof address.contact === 'object' ? address.contact : {};
  const streetLine = getFirst(
    addressFields.streetLine1, addressFields.addressLine1, addressFields.address1, addressFields.completeAddress,
    addressFields.streetAddress, addressFields.street_address, addressFields.address_line_1,
    addressFields.addressLine, addressFields.street, addressFields.line1, addressFields.buildingName
  );
  const city = getFirst(addressFields.city, addressFields.town, addressFields.cityName);
  const phoneNumber = getFirst(
    contact.phoneNumber, contact.phone, contact.mobile, contact.mobileNumber,
    addressFields.phoneNumber, addressFields.phone, addressFields.mobile, addressFields.mobileNo, addressFields.mobileNumber,
    addressFields.phone_number, fallback.phoneNumber, fallback.phone
  );
  const personName = getFirst(
    contact.personName, contact.name, contact.fullName,
    addressFields.contactName, addressFields.fullName, addressFields.name,
    fallback.name, 'Shipping Contact'
  );
  const companyName = getFirst(addressFields.companyName, addressFields.company, contact.companyName, fallback.company, personName);
  const errors = [];

  if (!streetLine) errors.push(`${label} address street line is required for FedEx shipment creation`);
  if (!city) errors.push(`${label} address city is required for FedEx shipment creation`);
  if (!phoneNumber) errors.push(`${label} contact phone number is required for FedEx shipment creation`);
  if (errors.length) throw shipmentValidationError(errors);

  return {
    contact: {
      personName: String(personName),
      companyName: String(companyName),
      phoneNumber: String(phoneNumber),
      ...(getFirst(contact.email, contact.emailAddress, addressFields.email, addressFields.emailAddress, fallback.email) ? { emailAddress: String(getFirst(contact.email, contact.emailAddress, addressFields.email, addressFields.emailAddress, fallback.email)) } : {})
    },
    address: {
      streetLines: [String(streetLine), getFirst(addressFields.streetLine2, addressFields.addressLine2, addressFields.address2, addressFields.street_address_2, addressFields.address_line_2, addressFields.line2, addressFields.landmark)].filter(Boolean),
      city: String(city),
      ...(getFirst(addressFields.stateOrProvinceCode, addressFields.state, addressFields.province, addressFields.emirate) ? { stateOrProvinceCode: String(getFirst(addressFields.stateOrProvinceCode, addressFields.state, addressFields.province, addressFields.emirate)) } : {}),
      postalCode: String(getFirst(addressFields.postalCode, addressFields.postal_code, addressFields.zipCode, addressFields.zip, addressFields.pincode, postalCode)),
      countryCode: resolveCountryCode(getFirst(addressFields.countryCode, addressFields.country, country))
    }
  };
}

function buildPackageSpecialServices(fedexOptions = {}) {
  if (!fedexOptions || typeof fedexOptions !== 'object' || Array.isArray(fedexOptions)) return null;

  const selectedBatteryTypes = [...new Set(asStringArray(
    fedexOptions.lithiumBatteryTypes ?? fedexOptions.lithiumBatteryType
  ))];
  const invalidBatteryTypes = selectedBatteryTypes.filter((type) => !LITHIUM_BATTERY_TYPES[type]);
  if (invalidBatteryTypes.length) {
    throw shipmentValidationError([`Unsupported lithium battery option(s): ${invalidBatteryTypes.join(', ')}`]);
  }

  const dangerousGoods = fedexOptions.dangerousGoods;
  const specialServiceTypes = [];
  const packageSpecialServices = {};

  if (selectedBatteryTypes.length) {
    specialServiceTypes.push('BATTERY');
    packageSpecialServices.batteryDetails = selectedBatteryTypes.map((type) => ({
      batteryMaterialType: LITHIUM_BATTERY_TYPES[type].batteryMaterialType,
      batteryPackingType: LITHIUM_BATTERY_TYPES[type].batteryPackingType,
      batteryRegulatoryType: 'IATA_SECTION_II'
    }));
  }

  if (dangerousGoods !== undefined && dangerousGoods !== null && dangerousGoods !== false) {
    const details = typeof dangerousGoods === 'string'
      ? { type: dangerousGoods }
      : dangerousGoods;
    const dangerousGoodsType = String(details.type || details.category || details.accessibility || '').toUpperCase();
    const accessibility = {
      ADG: 'ACCESSIBLE',
      ACCESSIBLE: 'ACCESSIBLE',
      IDG: 'INACCESSIBLE',
      INACCESSIBLE: 'INACCESSIBLE'
    }[dangerousGoodsType];

    if (!accessibility) {
      throw shipmentValidationError(['dangerousGoods.type must be ADG or IDG']);
    }
    if (details.cargoAircraftOnly !== undefined && typeof details.cargoAircraftOnly !== 'boolean') {
      throw shipmentValidationError(['dangerousGoods.cargoAircraftOnly must be true or false']);
    }

    specialServiceTypes.push('DANGEROUS_GOODS');
    packageSpecialServices.dangerousGoodsDetail = {
      accessibility,
      ...(typeof details.cargoAircraftOnly === 'boolean' ? { cargoAircraftOnly: details.cargoAircraftOnly } : {}),
      ...(asStringArray(details.options).length ? { options: asStringArray(details.options) } : {})
    };
  }

  return specialServiceTypes.length
    ? { specialServiceTypes, ...packageSpecialServices }
    : null;
}

function buildPackages(boxes, fedexOptions) {
  const packageSpecialServices = buildPackageSpecialServices(fedexOptions);
  return boxes.flatMap((box) => {
    const quantity = Number(box.quantity || 1);
    const item = {
      weight: { units: 'KG', value: Number(box.actualWeight || box.weight) },
      dimensions: {
        length: Math.round(Number(box.length)),
        width: Math.round(Number(box.breadth || box.width)),
        height: Math.round(Number(box.height)),
        units: 'CM'
      }
    };
    return Array.from({ length: quantity }, (_, index) => ({
      ...item,
      sequenceNumber: index + 1,
      ...(packageSpecialServices ? { packageSpecialServices } : {})
    }));
  }).map((item, index) => ({ ...item, sequenceNumber: index + 1 }));
}

function buildCustomsClearance(products, shipmentValue, currency, originCountry) {
  if (!products.length) throw shipmentValidationError(['products are required for an international FedEx shipment']);
  const commodities = products.map((product) => {
    const description = getFirst(product.description, product.name, product.productName, product.title);
    const quantity = Number(product.quantity || 1);
    const unitPrice = Number(getFirst(product.unitPrice, product.price, product.value, shipmentValue / quantity));
    if (!description || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw shipmentValidationError(['Each international product requires a description and a positive value']);
    }
    return {
      description: String(description),
      quantity,
      quantityUnits: product.quantityUnits || 'PCS',
      countryOfManufacture: resolveCountryCode(product.countryOfManufacture || originCountry),
      unitPrice: { amount: unitPrice, currency },
      customsValue: { amount: unitPrice * quantity, currency },
      weight: { units: 'KG', value: Number(product.actualWeight || 0.1) }
    };
  });

  return {
    dutiesPayment: {
      paymentType: 'SENDER',
      payor: { responsibleParty: { accountNumber: { value: fedexConfig.accountNumber } } }
    },
    commodities
  };
}

function toFedExShipmentPayload(order) {
  const countryFrom = resolveCountryCode(order.pickupCountry);
  const countryTo = resolveCountryCode(order.destinationCountry);
  const shipper = buildParty(order.pickupAddress, order.user, countryFrom, order.pickupPincode, 'Pickup');
  const recipient = buildParty(order.destinationAddress, {}, countryTo, order.destinationPincode, 'Destination');
  const requestedPackageLineItems = buildPackages(order.boxes, order.fedexOptions);
  const errors = [];

  if (!requestedPackageLineItems.length || requestedPackageLineItems.some((item) => !Number.isFinite(item.weight.value) || item.weight.value <= 0)) {
    errors.push('At least one package with a positive weight is required');
  }
  if (errors.length) throw shipmentValidationError(errors);

  const requestedShipment = {
    shipDateStamp: new Date().toISOString().slice(0, 10),
    pickupType: 'USE_SCHEDULED_PICKUP',
    serviceType: order.serviceType || fedexConfig.defaultServiceType,
    packagingType: order.packagingType || 'YOUR_PACKAGING',
    shipper,
    recipients: [recipient],
    shippingChargesPayment: {
      paymentType: 'SENDER',
      payor: { responsibleParty: { accountNumber: { value: fedexConfig.accountNumber } } }
    },
    labelSpecification: {
      labelFormatType: 'COMMON2D',
      imageType: 'PDF',
      labelStockType: 'PAPER_85X11_TOP_HALF_LABEL'
    },
    requestedPackageLineItems
  };

  if (countryFrom !== countryTo) {
    const amount = Number(order.shipmentValue);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw shipmentValidationError(['shipmentValue is required for an international FedEx shipment']);
    }
    requestedShipment.customsClearanceDetail = buildCustomsClearance(
      order.products,
      amount,
      order.currency || 'USD',
      countryFrom
    );
  }

  console.log(JSON.stringify({
    labelResponseOptions: 'LABEL',
    accountNumber: { value: fedexConfig.accountNumber },
    requestedShipment
  }))
  return {
    labelResponseOptions: 'LABEL',
    accountNumber: { value: fedexConfig.accountNumber },
    requestedShipment
  };
}

function normalizeShipmentResponse(response) {
  const transactionShipments = response.output?.transactionShipments || [];
  const shipment = transactionShipments[0] || {};
  const completedShipment = shipment.completedShipmentDetail || {};
  const packageDetail = completedShipment.completedPackageDetails?.[0] || {};
  const pieceResponse = shipment.pieceResponses?.[0] || {};
  const labelDocument = pieceResponse.packageDocuments?.find(
    (document) => document.contentType === 'LABEL' && document.encodedLabel
  );
  return {
    transactionId: response.transactionId,
    trackingNumber: shipment.masterTrackingNumber || completedShipment.masterTrackingId?.trackingNumber || pieceResponse.trackingNumber || packageDetail.trackingIds?.[0]?.trackingNumber,
    serviceType: shipment.serviceType || completedShipment.serviceType,
    shipDate: shipment.shipDatestamp || completedShipment.shipDatestamp,
    label: labelDocument?.encodedLabel || packageDetail.label?.parts?.[0]?.image,
    labelFormat: labelDocument?.docType || packageDetail.label?.imageType,
    alerts: shipment.alerts || []
  };
}

async function createFedExShipment(order) {
  return normalizeShipmentResponse(await createShipment(toFedExShipmentPayload(order)));
}

module.exports = {
  createFedExShipment,
  toFedExShipmentPayload,
  normalizeShipmentResponse,
  LITHIUM_BATTERY_TYPES,
  buildParty
};
