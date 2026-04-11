const EXCLUDED_PICKUP_COUNTRIES = new Set([
  'india',
  'ind',
  'china',
  'usa'
]);

const OFFER_MIN_ACTUAL_WEIGHT = 11;
const OFFER_MIN_CHARGEABLE_WEIGHT = 21;
const VOLUMETRIC_DIVISOR = 5000;

function normalizeCountry(country) {
  return String(country || '').trim().toLowerCase();
}

function isTwentyOneKgOfferEligibleRoute(pickupCountry, destinationCountry) {
  const normalizedPickup = normalizeCountry(pickupCountry);
  const normalizedDestination = normalizeCountry(destinationCountry);

  if (!normalizedPickup || !normalizedDestination) {
    return false;
  }

  return !EXCLUDED_PICKUP_COUNTRIES.has(normalizedPickup);
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

function getTwentyOneKgOfferMessage({ pickupCountry, destinationCountry, actualWeight, dimensions }) {
  if (!isTwentyOneKgOfferEligibleRoute(pickupCountry, destinationCountry)) {
    return null;
  }

  const normalizedActualWeight = Number(actualWeight);
  const chargeableWeight = getChargeableWeight(actualWeight, dimensions);

  return {
    code: 'chargeable-weight-21-plus-offer',
    title: 'FedEx 21+ kg discounted rate available',
    message: 'For this route, FedEx discounted rates apply when total chargeable weight is 21 kg or more.',
    carrier: 'FedEx',
    rules: [
      'This is based on total chargeable weight across all boxes.',
      'You can qualify by increasing actual weight or volumetric weight.',
      'Actual weight must be at least 11 kg to use the FedEx 21+ kg discounted rate.'
    ],
    thresholds: {
      minimumActualWeight: OFFER_MIN_ACTUAL_WEIGHT,
      minimumChargeableWeight: OFFER_MIN_CHARGEABLE_WEIGHT
    },
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

module.exports = {
  getChargeableWeight,
  getTwentyOneKgOfferMessage,
  isTwentyOneKgOfferEligibleRoute
};
