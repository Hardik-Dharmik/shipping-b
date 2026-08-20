async function uploadUPSLabel(supabase, encodedLabel, trackingNumber, imageType = 'PDF') {
  if (!encodedLabel) return null;

  const normalizedImageType = String(imageType || 'PDF').toUpperCase();
  if (normalizedImageType !== 'PDF') {
    const error = new Error(`Unsupported UPS label format: ${normalizedImageType}. Expected PDF.`);
    error.code = 'UPS_LABEL_FORMAT_UNSUPPORTED';
    error.statusCode = 502;
    throw error;
  }

  const base64 = String(encodedLabel).replace(/^data:application\/pdf;base64,/i, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) {
    const error = new Error('UPS returned an empty shipping label');
    error.code = 'UPS_EMPTY_LABEL';
    error.statusCode = 502;
    throw error;
  }

  const filePath = `orders/${trackingNumber}/ups-label.pdf`;
  const { error } = await supabase.storage
    .from('order-documents')
    .upload(filePath, buffer, { contentType: 'application/pdf', upsert: true });

  if (error) throw error;

  const { data } = supabase.storage
    .from('order-documents')
    .getPublicUrl(filePath);

  return data.publicUrl;
}

module.exports = { uploadUPSLabel };
