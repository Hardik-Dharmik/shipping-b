const PDFDocument = require('pdfkit');

const generateOrderPdf = (order) => {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40 });
    const buffers = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));

    doc.fontSize(20).text('Shipment Order', { align: 'center' });
    doc.moveDown();

    doc.fontSize(12).text(`AWB Number: ${order.awb_number}`);
    doc.text(`Order ID: ${order.orderId}`);
    doc.text(`Created At: ${new Date(order.createdAt).toLocaleString()}`);
    doc.moveDown();

    doc.fontSize(14).text('Pickup');
    doc.fontSize(11).text(`${order.pickup.country} - ${order.pickup.pincode}`);
    doc.moveDown();

    doc.fontSize(14).text('Delivery');
    doc.fontSize(11).text(`${order.destination.country} - ${order.destination.pincode}`);
    doc.moveDown();

    doc.fontSize(14).text('Boxes');
    order.boxes.forEach((box, i) => {
      doc.fontSize(11).text(
        `Box ${i + 1}: ${box.actualWeight} kg | ${box.dimensions.length}×${box.dimensions.breadth}×${box.dimensions.height} cm | Chargeable: ${box.chargeableWeight} kg`
      );
    });

    doc.moveDown();
    doc.fontSize(10).text('System generated document', { align: 'center' });

    doc.end();
  });
};

module.exports = generateOrderPdf;
