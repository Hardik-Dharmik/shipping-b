const express = require('express');
const multer = require('multer');
const { randomUUID } = require('crypto');
const { authenticateToken } = require('./auth');
const { supabaseAdmin } = require('../supabase');
const { resolveCustomerId, ORDER_CUSTOMER_SELECT } = require('../utils/customers');
const router = express.Router();
const flags = ['requireBOE', 'requireDO', 'exportDeclaration', 'dutyExemption', 'temporaryExportForRepairAndReturn', 'insurance'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 14, fields: 8 } }).fields([
  ...['awbFile', 'pickupScreenshot', 'destinationScreenshot', 'packagingScreenshot'].map(name => ({ name, maxCount: 1 })),
  { name: 'otherDocuments', maxCount: 10 }
]);
router.post('/order/manual', authenticateToken, (req, res, next) => upload(req, res, error => {
  if (error) return res.status(400).json({ success: false, error: error.message });
  next();
}), async (req, res) => {
  const paths = [];
  const bucket = supabaseAdmin.storage.from('order-documents');
  try {
    const bad = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
    const awbNumber = typeof req.body.awbNumber === 'string' ? req.body.awbNumber.trim() : '';
    const agentName = typeof req.body.agentName === 'string' ? req.body.agentName.trim() : '';
    if (!awbNumber || awbNumber.length > 100) bad('AWB number is required (maximum 100 characters)');
    if (!agentName || agentName.length > 200) bad('Agent name is required (maximum 200 characters)');
    if (!req.body.customerId) bad('Customer is required');
    const parse = (value, fallback) => {
      try { return value === undefined ? fallback : JSON.parse(value); }
      catch { bad('Invalid document names or compliance JSON'); }
    };
    const names = parse(req.body.documentNames, []);
    const selected = parse(req.body.compliance, {});
    if (!selected || Array.isArray(selected) || typeof selected !== 'object') bad('Compliance must be an object');
    const compliance = {};
    for (const flag of flags) {
      if (selected[flag] !== undefined && typeof selected[flag] !== 'boolean') bad(`${flag} must be a boolean`);
      compliance[flag] = selected[flag] === true;
    }
    const files = req.files || {};
    for (const field of ['awbFile', 'pickupScreenshot', 'destinationScreenshot', 'packagingScreenshot']) {
      if (!files[field]?.length) bad(`${field} is required`);
    }
    const others = files.otherDocuments || [];
    if (!Array.isArray(names) || names.length !== others.length || names.some(name => typeof name !== 'string' || !name.trim() || name.trim().length > 200)) bad('Each other document requires a name (maximum 200 characters)');
    for (const [field, group] of Object.entries(files)) {
      for (const file of group) {
        if (!file.size) bad('Empty files are not allowed');
        const pdf = file.mimetype === 'application/pdf' && /\.pdf$/i.test(file.originalname) && file.buffer.subarray(0, 5).toString() === '%PDF-';
        const image = (file.mimetype === 'image/png' && /\.png$/i.test(file.originalname) && file.buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') ||
          (file.mimetype === 'image/jpeg' && /\.jpe?g$/i.test(file.originalname) && file.buffer.subarray(0, 3).toString('hex') === 'ffd8ff') ||
          (file.mimetype === 'image/webp' && /\.webp$/i.test(file.originalname) && file.buffer.subarray(0, 4).toString() === 'RIFF' && file.buffer.subarray(8, 12).toString() === 'WEBP');
        if (field === 'awbFile' ? !pdf : field.endsWith('Screenshot') ? !image : !(pdf || image)) bad(`${field}: upload ${field === 'awbFile' ? 'a PDF' : field.endsWith('Screenshot') ? 'a PNG, JPEG or WebP image' : 'a PDF, PNG, JPEG or WebP file'}`);
      }
    }
    const customerId = await resolveCustomerId(req.body.customerId);
    const id = randomUUID();
    const save = async (file, folder) => {
      const filePath = `orders/${req.user.id}/${id}/${folder}/${randomUUID()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { error } = await bucket.upload(filePath, file.buffer, { contentType: file.mimetype });
      if (error) throw error;
      paths.push(filePath);
      return { name: file.originalname, url: bucket.getPublicUrl(filePath).data.publicUrl, contentType: file.mimetype };
    };
    const awbFile = await save(files.awbFile[0], 'awb');
    const screenshots = {};
    for (const section of ['pickup', 'destination', 'packaging']) screenshots[section] = await save(files[`${section}Screenshot`][0], section);
    const otherDocuments = [];
    for (let i = 0; i < others.length; i++) otherDocuments.push({ ...await save(others[i], 'other'), documentName: names[i].trim() });
    const { data, error } = await supabaseAdmin.from('orders').insert({ id, user_id: req.user.id, customer_id: customerId,
      awb_number: awbNumber, awb_pdf_url: awbFile.url, carrier: {}, status: 'CREATED',
      order_data: { orderType: 'manual', agentName, awbFile, screenshots, otherDocuments, compliance }
    }).select(ORDER_CUSTOMER_SELECT).single();
    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (error) {
    if (paths.length) {
      try { const result = await bucket.remove(paths); if (result.error) console.error('Manual order upload cleanup failed:', result.error); }
      catch (cleanupError) { console.error('Manual order upload cleanup failed:', cleanupError); }
    }
    const status = error.code === '23505' ? 409 : error.statusCode || 500;
    return res.status(status).json({ success: false, error: status === 409 ? 'An order with this AWB number already exists' : status === 500 ? 'Unable to create manual order' : error.message });
  }
});
module.exports = router;
