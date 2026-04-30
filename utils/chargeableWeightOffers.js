const UAE_COUNTRY_ALIASES = new Set([
  'uae',
  'united arab emirates'
]);

const INDIA_COUNTRY_ALIASES = new Set([
  'india',
  'ind'
]);

const CHINA_COUNTRY_ALIASES = new Set([
  'china',
  'prc'
]);

const USA_COUNTRY_ALIASES = new Set([
  'usa',
  'us',
  'united states',
  'united states of america'
]);

const EXCLUDED_TWENTY_ONE_KG_PICKUP_COUNTRIES = new Set([
  ...INDIA_COUNTRY_ALIASES,
  ...CHINA_COUNTRY_ALIASES,
  ...USA_COUNTRY_ALIASES
]);

const TWENTY_ONE_KG_OFFER_MIN_ACTUAL_WEIGHT = 11;
const TWENTY_ONE_KG_OFFER_MIN_CHARGEABLE_WEIGHT = 21;
const IMPORT_OFFER_MIN_CHARGEABLE_WEIGHT = 71;
const INDIA_IMPORT_OFFER_MIN_BOX_COUNT = 2;
const INDIA_IMPORT_OFFER_MIN_BOX_ACTUAL_WEIGHT = 11;
const CHINA_USA_IMPORT_OFFER_MIN_ACTUAL_WEIGHT = 40;
const VOLUMETRIC_DIVISOR = 5000;
const FEDEX_DISCOUNTED_RATE_PER_KG = 6;

function normalizeCountry(country) {
  return String(country || '').trim().toLowerCase();
}

function matchesCountryAlias(country, aliases) {
  return aliases.has(normalizeCountry(country));
}

function isUaeCountry(country) {
  return matchesCountryAlias(country, UAE_COUNTRY_ALIASES);
}

function isIndiaCountry(country) {
  return matchesCountryAlias(country, INDIA_COUNTRY_ALIASES);
}

function isChinaCountry(country) {
  return matchesCountryAlias(country, CHINA_COUNTRY_ALIASES);
}

function isUsaCountry(country) {
  return matchesCountryAlias(country, USA_COUNTRY_ALIASES);
}

function getVolumetricWeight(dimensions) {
  if (!dimensions) return null;

  const length = Number(dimensions.length);
  const breadth = Number(dimensions.breadth);
  const height = Number(dimensions.height);

  if (![length, breadth, height].every(Number.isFinite) || length <= 0 || breadth <= 0 || height <= 0) {
    return null;
  }

  return (length * breadth * height) / VOLUMETRIC_DIVISOR;
}

function getChargeableWeight(actualWeight, dimensions) {
  const normalizedActualWeight = Number(actualWeight);
  const volumetricWeight = getVolumetricWeight(dimensions);

  if (!Number.isFinite(normalizedActualWeight) || normalizedActualWeight <= 0) {
    return null;
  }

  if (!Number.isFinite(volumetricWeight)) {
    return normalizedActualWeight;
  }

  return Math.max(normalizedActualWeight, volumetricWeight);
}

function normalizeBoxes(boxes) {
  if (!Array.isArray(boxes)) {
    return [];
  }

  return boxes
    .map((box) => ({
      quantity: Number(box?.quantity),
      actualWeight: Number(box?.actualWeight)
    }))
    .filter((box) => Number.isFinite(box.quantity) && box.quantity > 0 && Number.isFinite(box.actualWeight) && box.actualWeight > 0);
}

function getTotalBoxCount(boxes) {
  return normalizeBoxes(boxes).reduce((sum, box) => sum + box.quantity, 0);
}

function everyBoxMeetsMinimumActualWeight(boxes, minActualWeight) {
  const normalizedBoxes = normalizeBoxes(boxes);

  if (normalizedBoxes.length === 0) {
    return false;
  }

  return normalizedBoxes.every((box) => box.actualWeight >= minActualWeight);
}

function isTwentyOneKgOfferEligibleRoute(pickupCountry, destinationCountry) {
  const normalizedPickup = normalizeCountry(pickupCountry);
  const normalizedDestination = normalizeCountry(destinationCountry);

  if (!normalizedPickup || !normalizedDestination) {
    return false;
  }

  return (
    (isUaeCountry(normalizedPickup) || isUaeCountry(normalizedDestination)) &&
    !EXCLUDED_TWENTY_ONE_KG_PICKUP_COUNTRIES.has(normalizedPickup)
  );
}

function isFedExTwentyOneKgOfferApplicable({
  pickupCountry,
  destinationCountry,
  actualWeight,
  chargeableWeight
}) {
  const normalizedActualWeight = Number(actualWeight);
  const normalizedChargeableWeight = Number(chargeableWeight);

  if (!isTwentyOneKgOfferEligibleRoute(pickupCountry, destinationCountry)) {
    return false;
  }

  if (!Number.isFinite(normalizedActualWeight) || !Number.isFinite(normalizedChargeableWeight)) {
    return false;
  }

  return (
    normalizedActualWeight >= TWENTY_ONE_KG_OFFER_MIN_ACTUAL_WEIGHT &&
    normalizedChargeableWeight >= TWENTY_ONE_KG_OFFER_MIN_CHARGEABLE_WEIGHT
  );
}

function getImportOriginConfig(pickupCountry) {
  if (isIndiaCountry(pickupCountry)) {
    return {
      originLabel: 'India',
      carriers: ['FedEx'],
      rules: [
        'Applicable only for import shipments from India to UAE.',
        'Total chargeable weight must be 71 kg or more.',
        'At least 2 boxes are required.',
        'Each box must have an actual weight of at least 11 kg.'
      ],
      isEligible({ actualWeight, chargeableWeight, boxes }) {
        return (
          Number(actualWeight) > 0 &&
          Number(chargeableWeight) >= IMPORT_OFFER_MIN_CHARGEABLE_WEIGHT &&
          getTotalBoxCount(boxes) >= INDIA_IMPORT_OFFER_MIN_BOX_COUNT &&
          everyBoxMeetsMinimumActualWeight(boxes, INDIA_IMPORT_OFFER_MIN_BOX_ACTUAL_WEIGHT)
        );
      }
    };
  }

  if (isChinaCountry(pickupCountry)) {
    return {
      originLabel: 'China',
      carriers: ['FedEx', 'UPS'],
      rules: [
        'Applicable only for import shipments from China to UAE.',
        'Works for 1 box or more.',
        'Total chargeable weight must be 71 kg or more.',
        'Total actual weight must be above 40 kg.'
      ],
      isEligible({ actualWeight, chargeableWeight }) {
        return (
          Number(actualWeight) > CHINA_USA_IMPORT_OFFER_MIN_ACTUAL_WEIGHT &&
          Number(chargeableWeight) >= IMPORT_OFFER_MIN_CHARGEABLE_WEIGHT
        );
      }
    };
  }

  if (isUsaCountry(pickupCountry)) {
    return {
      originLabel: 'USA',
      carriers: ['FedEx', 'UPS'],
      rules: [
        'Applicable only for import shipments from USA to UAE.',
        'Works for 1 box or more.',
        'Total chargeable weight must be 71 kg or more.',
        'Total actual weight must be above 40 kg.'
      ],
      isEligible({ actualWeight, chargeableWeight }) {
        return (
          Number(actualWeight) > CHINA_USA_IMPORT_OFFER_MIN_ACTUAL_WEIGHT &&
          Number(chargeableWeight) >= IMPORT_OFFER_MIN_CHARGEABLE_WEIGHT
        );
      }
    };
  }

  return null;
}

function isImportOfferRoute(pickupCountry, destinationCountry) {
  return isUaeCountry(destinationCountry) && Boolean(getImportOriginConfig(pickupCountry));
}

function isSeventyOneKgImportOfferApplicable({
  pickupCountry,
  destinationCountry,
  actualWeight,
  chargeableWeight,
  boxes,
  carrierName
}) {
  if (!isImportOfferRoute(pickupCountry, destinationCountry)) {
    return false;
  }

  const config = getImportOriginConfig(pickupCountry);
  if (!config) {
    return false;
  }

  const normalizedCarrierName = String(carrierName || '').trim().toLowerCase();
  if (
    normalizedCarrierName &&
    !config.carriers.some((carrier) => carrier.toLowerCase() === normalizedCarrierName)
  ) {
    return false;
  }

  return config.isEligible({ actualWeight, chargeableWeight, boxes });
}

function getTwentyOneKgOfferMessage({ pickupCountry, destinationCountry, actualWeight, dimensions }) {
  if (!isTwentyOneKgOfferEligibleRoute(pickupCountry, destinationCountry)) {
    return null;
  }

  const normalizedActualWeight = Number(actualWeight);
  const chargeableWeight = getChargeableWeight(actualWeight, dimensions);

  return {
    code: 'chargeable-weight-21-plus-offer',
    title: 'FedEx 21+ kg discounted rate available',
    message: 'FedEx discounted rates apply when total chargeable weight is 21 kg or more on UAE-linked routes.',
    carrier: 'FedEx',
    rules: [
      'This is based on total chargeable weight across all boxes.',
      'You can qualify by increasing actual weight or volumetric weight.',
      'Actual weight must be at least 11 kg to use the FedEx 21+ kg discounted rate.'
    ],
    thresholds: {
      minimumActualWeight: TWENTY_ONE_KG_OFFER_MIN_ACTUAL_WEIGHT,
      minimumChargeableWeight: TWENTY_ONE_KG_OFFER_MIN_CHARGEABLE_WEIGHT
    },
    discountedRatePerKg: FEDEX_DISCOUNTED_RATE_PER_KG,
    current: {
      actualWeight: Number.isFinite(normalizedActualWeight)
        ? Number(normalizedActualWeight.toFixed(2))
        : null,
      chargeableWeight: Number.isFinite(chargeableWeight)
        ? Number(chargeableWeight.toFixed(2))
        : null
    }
  };
}

function getSeventyOneKgImportOfferMessages({
  pickupCountry,
  destinationCountry,
  actualWeight,
  chargeableWeight,
  dimensions,
  boxes
}) {
  if (!isImportOfferRoute(pickupCountry, destinationCountry)) {
    return [];
  }

  const config = getImportOriginConfig(pickupCountry);
  if (!config) {
    return [];
  }

  const normalizedActualWeight = Number(actualWeight);
  const resolvedChargeableWeight = Number.isFinite(Number(chargeableWeight))
    ? Number(chargeableWeight)
    : getChargeableWeight(actualWeight, dimensions);

  return config.carriers.map((carrier) => ({
    code: `import-${config.originLabel.toLowerCase()}-71-plus-${carrier.toLowerCase()}-offer`,
    title: `${carrier} 71+ kg import discounted rate available`,
    message: `${carrier} discounted rates apply for qualifying import shipments from ${config.originLabel} to UAE.`,
    carrier,
    rules: config.rules,
    thresholds: {
      minimumChargeableWeight: IMPORT_OFFER_MIN_CHARGEABLE_WEIGHT,
      minimumActualWeight: isIndiaCountry(pickupCountry)
        ? INDIA_IMPORT_OFFER_MIN_BOX_ACTUAL_WEIGHT
        : CHINA_USA_IMPORT_OFFER_MIN_ACTUAL_WEIGHT
    },
    current: {
      actualWeight: Number.isFinite(normalizedActualWeight)
        ? Number(normalizedActualWeight.toFixed(2))
        : null,
      chargeableWeight: Number.isFinite(resolvedChargeableWeight)
        ? Number(resolvedChargeableWeight.toFixed(2))
        : null,
      totalBoxes: getTotalBoxCount(boxes) || null
    },
    eligible: isSeventyOneKgImportOfferApplicable({
      pickupCountry,
      destinationCountry,
      actualWeight,
      chargeableWeight: resolvedChargeableWeight,
      boxes,
      carrierName: carrier
    })
  }));
}

function getRatePerKg({
  carrierName,
  pickupCountry,
  destinationCountry,
  actualWeight,
  chargeableWeight,
  standardRatePerKg,
  boxes
}) {
  const normalizedCarrierName = String(carrierName || '').trim().toLowerCase();

  if (
    normalizedCarrierName === 'fedex' &&
    isFedExTwentyOneKgOfferApplicable({
      pickupCountry,
      destinationCountry,
      actualWeight,
      chargeableWeight
    })
  ) {
    return FEDEX_DISCOUNTED_RATE_PER_KG;
  }

  if (
    ['fedex', 'ups'].includes(normalizedCarrierName) &&
    isSeventyOneKgImportOfferApplicable({
      pickupCountry,
      destinationCountry,
      actualWeight,
      chargeableWeight,
      boxes,
      carrierName
    })
  ) {
    return standardRatePerKg;
  }

  return standardRatePerKg;
}

function getOfferMessages({
  pickupCountry,
  destinationCountry,
  actualWeight,
  chargeableWeight,
  dimensions,
  boxes
}) {
  const offers = [];
  const twentyOneKgOffer = getTwentyOneKgOfferMessage({
    pickupCountry,
    destinationCountry,
    actualWeight,
    dimensions
  });

  if (twentyOneKgOffer) {
    offers.push(twentyOneKgOffer);
  }

  offers.push(
    ...getSeventyOneKgImportOfferMessages({
      pickupCountry,
      destinationCountry,
      actualWeight,
      chargeableWeight,
      dimensions,
      boxes
    })
  );

  return offers;
}

module.exports = {
  FEDEX_DISCOUNTED_RATE_PER_KG,
  getChargeableWeight,
  getOfferMessages,
  getRatePerKg,
  getSeventyOneKgImportOfferMessages,
  getTwentyOneKgOfferMessage,
  isFedExTwentyOneKgOfferApplicable,
  isImportOfferRoute,
  isSeventyOneKgImportOfferApplicable,
  isTwentyOneKgOfferEligibleRoute
};
