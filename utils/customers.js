const { supabaseAdmin } = require('../supabase');

const CUSTOMER_FIELDS = 'id, company_name, email, phone_number, created_at';
const ORDER_CUSTOMER_SELECT = '*, customer:customers!orders_customer_id_fkey(id, company_name, email, phone_number)';
const isCustomerId = (value) => typeof value === 'string' && /^[0-9]{6}$/.test(value);

const resolveCustomerId = async (requestedId, linkedId = null) => {
  const supplied = requestedId !== undefined && requestedId !== null && requestedId !== '';
  if ((supplied && !isCustomerId(requestedId)) || (linkedId != null && linkedId !== '' && !isCustomerId(linkedId))) {
    throw Object.assign(new Error('customerId must be a 6 digit string'), { statusCode: 400 });
  }
  if (linkedId && supplied && requestedId !== linkedId) {
    throw Object.assign(new Error('customerId must match the customer selected for the address form'), { statusCode: 400 });
  }
  const id = linkedId || (supplied ? requestedId : null);
  if (!id) return null;
  const { data, error } = await supabaseAdmin.from('customers').select('id')
    .eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Customer not found'), { statusCode: 404 });
  return data.id;
};

module.exports = { CUSTOMER_FIELDS, ORDER_CUSTOMER_SELECT, isCustomerId, resolveCustomerId };
