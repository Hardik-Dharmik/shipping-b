// Response-only placeholders: never pass these values to a carrier API.
function withRateResponseDefaults(response) {
  const dummyFields = [];
  const missing = (value) => value === undefined || value === null || value === '';
  function fill(value, defaults, path = '') {
    const result = { ...value };
    for (const [key, fallback] of Object.entries(defaults)) {
      const field = path ? `${path}.${key}` : key;
      if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
        result[key] = fill(result[key], fallback, field);
      } else if (missing(result[key])) {
        result[key] = fallback;
        dummyFields.push(field);
      }
    }
    return result;
  }

  const result = fill(response, {
    pickup: { country: 'AE', pincode: '00000' },
    destination: { country: 'IN', pincode: '440002' },
    weight: { actualWeight: 2.5, unit: 'kg' },
    dimensions: { length: 30, breadth: 20, height: 15, unit: 'cm' },
    shipmentValue: { value: 1000, currency: 'AED' },
    compliance: { requireBOE: false, requireDO: false, tempExport: false },
    insurance: { selected: true, charge: 10, currency: 'AED' },
    otherCharges: { amount: 15, currency: 'AED' },
    offers: ['Sample offer: discounted rates for shipments above 10 kg']
  });
  result.quotes = (response.quotes || []).map((quote, index) => {
    const carrier = quote.carrier || 'FedEx';
    const services = {
      FedEx: ['FEDEX_INTERNATIONAL_PRIORITY', 'FedEx International Priority'],
      UPS: ['UPS_WORLDWIDE_EXPRESS', 'UPS Worldwide Express'],
      DHL: ['DHL_EXPRESS_WORLDWIDE', 'DHL Express Worldwide']
    };
    const [serviceType, serviceName] = services[carrier] || ['EXPRESS', 'International Express'];
    const days = quote.estimatedDeliveryDays ?? 5;
    const delivery = new Date(response.calculatedAt || Date.now());
    if (!Number.isFinite(delivery.getTime())) delivery.setTime(Date.now());
    for (let added = 0; added < days;) {
      delivery.setUTCDate(delivery.getUTCDate() + 1);
      if (![0, 6].includes(delivery.getUTCDay())) added++;
    }
    delivery.setUTCHours(17, 0, 0, 0);
    const existingDate = quote.estimatedDeliveryDateTime || quote.estimatedDeliveryDate;
    if (existingDate && Number.isFinite(Date.parse(existingDate))) {
      const parsed = new Date(existingDate);
      delivery.setTime(parsed.getTime());
      if (/^\d{4}-\d{2}-\d{2}$/.test(existingDate)) delivery.setUTCHours(17, 0, 0, 0);
    }
    const total = quote.cost ?? quote.costBreakdown?.totalCost ?? 180;
    const additional = quote.costBreakdown?.additionalCharges ?? 0;
    const base = quote.costBreakdown?.baseShippingCost ?? Math.max(0, total - additional);
    const weight = quote.costBreakdown?.chargeableWeight ?? result.weight.actualWeight;
    return fill(quote, {
      carrier, serviceType, serviceName, packagingType: 'YOUR_PACKAGING',
      cost: total, currency: 'AED', estimatedDeliveryDays: days,
      estimatedDelivery: days + ' business days',
      estimatedDeliveryDate: delivery.toISOString().slice(0, 10),
      estimatedDeliveryTime: delivery.toISOString().slice(11, 19),
      estimatedDeliveryDateTime: delivery.toISOString(),
      estimatedDeliveryReadable: delivery.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'long', timeStyle: 'short' }) + ' UTC',
      customerMessages: [{ code: 'SAMPLE', message: 'Sample delivery estimate for display purposes.' }],
      costBreakdown: {
        weight: result.weight.actualWeight, chargeableWeight: weight,
        ratePerKg: weight > 0 ? Number((base / weight).toFixed(2)) : 0,
        baseShippingCost: base, additionalCharges: additional,
        totalCost: total, currency: quote.currency || 'AED',
        complianceCharges: {
          boeCharge: 0, doCharge: 0, temporaryExportCharge: 0,
          exportDeclarationCharge: 0, insuranceCharge: 0, otherCharges: 0
        }
      }
    }, 'quotes[' + index + ']');
  });
  // Lets consumers distinguish placeholder values from actual quote data.
  result.dummyFields = dummyFields;
  return result;
}

module.exports = { withRateResponseDefaults };
