const { supabaseAdmin } = require('../supabase');

const normalizeLinkedOrderForDisplay = (order) => {
  const orderData = order?.order_data || {};
  if (!orderData.createdFromAddressFormId) return order;

  const boxes = Array.isArray(orderData.boxes) ? orderData.boxes : [];
  const declaredWeight = Number(orderData.weight?.declared ?? orderData.actualWeight);
  const chargeableWeight = boxes.reduce((total, box) => {
    const itemWeight = Number(box.chargeableWeight ?? box.actualWeight ?? box.weight ?? 0);
    return total + (itemWeight * Number(box.quantity || 1));
  }, 0);
  const quote = orderData.selectedServiceQuote || {};
  const carrier = { ...(orderData.carrier || order.carrier || {}) };
  const quoteCost = Number(quote.totalNetCharge || quote.totalCharge || 0);
  if (quoteCost > 0 && !Number.isFinite(Number(carrier.cost))) {
    carrier.cost = quoteCost;
    carrier.currency = carrier.currency || quote.currency || 'AED';
    carrier.costBreakdown = {
      weight: declaredWeight,
      baseShippingCost: quoteCost,
      additionalCharges: 0,
      totalCost: quoteCost,
      currency: carrier.currency
    };
  }
  const shipmentValue = Number(orderData.shipmentValue);
  return {
    ...order,
    carrier,
    order_data: {
      ...orderData,
      carrier,
      weight: orderData.weight || {
        declared: Number.isFinite(declaredWeight) ? declaredWeight : 0,
        chargeable: Number(chargeableWeight.toFixed(2)),
        unit: 'kg'
      },
      shipmentValue: orderData.shipmentValue && typeof orderData.shipmentValue === 'object'
        ? orderData.shipmentValue
        : (Number.isFinite(shipmentValue) && shipmentValue > 0
          ? { value: shipmentValue, currency: orderData.currency || carrier.currency || 'AED' }
          : null)
    }
  };
};


const getOrderDetails = async (order) => {
    const { data: pickup, error: pickupError } = await supabaseAdmin
      .from('pickups')
      .select('id, order_id, awb_number, carrier, carrier_confirmation_code, carrier_location_code, scheduled_date, status, request_data, created_at, updated_at, cancelled_at')
      .eq('order_id', order.id)
      .eq('user_id', order.user_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pickupError) throw pickupError;

    const displayOrder = normalizeLinkedOrderForDisplay(order);
    const displayCarrier = displayOrder.order_data?.carrier || displayOrder.carrier || {};
    const costBreakdown = displayCarrier.costBreakdown || {
      weight: displayOrder.order_data?.weight?.declared || 0,
      baseShippingCost: Number(displayCarrier.cost || 0),
      additionalCharges: 0,
      totalCost: Number(displayCarrier.cost || 0),
      currency: displayCarrier.currency || 'AED'
    };

    return {
        order: displayOrder,
        pickup: pickup || null,
        costBreakdown,
        carrierCostBreakdown: {
          carrier: displayCarrier.carrier || displayCarrier.name || null,
          serviceType: displayCarrier.serviceType || null,
          serviceName: displayCarrier.serviceName || null,
          cost: Number(displayCarrier.cost || costBreakdown.totalCost || 0),
          currency: displayCarrier.currency || costBreakdown.currency || 'AED',
          breakdown: costBreakdown
        }
    };
};

module.exports = { normalizeLinkedOrderForDisplay, getOrderDetails };
