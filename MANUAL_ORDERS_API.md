# Manual orders

`POST /api/shipping/order/manual` requires a bearer token and multipart form data.

Required fields: `awbNumber` (max 100 characters), `agentName` (max 200), `customerId` (existing six-digit customer ID), `awbFile` (PDF), `pickupScreenshot`, `destinationScreenshot`, and `packagingScreenshot` (PNG/JPEG/WebP).

Optional: repeat `otherDocuments` for up to 10 PDF/image files and send `documentNames` as a JSON array of nonempty names in the same order. Every file must be nonempty and at most 10 MB.

`compliance` is a JSON object with boolean fields `requireBOE`, `requireDO`, `exportDeclaration`, `dutyExemption`, `temporaryExportForRepairAndReturn`, and `insurance`. Omitted flags default to false. These record the user's selections; no carrier booking or pricing is generated. Export declaration is explicitly selected because addresses are supplied as screenshots.

Returns `{ success: true, data: order }` with HTTP 201. Duplicate AWBs return 409; invalid input returns 400; missing customers return 404. Uploaded files are removed if a later upload or database insert fails.

Uses the existing orders table, customer foreign key, and `order-documents` bucket; no new database migration is required. Existing customer migrations and the existing publicly readable document storage configuration must already be applied.

Manual orders appear in existing authenticated order lists, identified by `order_data.orderType === 'manual'`. The existing detail endpoint returns the complete order, including `agentName`, `awbFile`, `screenshots`, `otherDocuments`, and `compliance` inside `order_data`; `awb_number`, `awb_pdf_url`, `customer`, and `created_at` retain their existing locations. Manual order cost breakdowns and pickup are null.

Frontend: `/orders/manual`, linked from the order list. Manual rows show AWB, customer and created date, plus the details link. The remaining shipment columns are blank placeholders. The details page displays the PDF link, screenshot previews, named document links and compliance selections.
