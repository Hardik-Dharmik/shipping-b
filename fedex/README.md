# FedEx integration

This folder contains all FedEx-specific code. Its rate function is used internally by the existing authenticated rate calculator endpoint:

`POST /api/shipping/quote`

Required server environment variables:

```env
FEDEX_CLIENT_ID=your_fedex_project_api_key
FEDEX_CLIENT_SECRET=your_fedex_project_secret_key
FEDEX_ACCOUNT_NUMBER=your_fedex_account_number
```

Optional variables:

```env
# Defaults to sandbox outside production and production when NODE_ENV=production.
FEDEX_API_BASE_URL=https://apis-sandbox.fedex.com
FEDEX_GRANT_TYPE=client_credentials
# Used only when the frontend does not send the serviceType selected from the rate quote.
FEDEX_DEFAULT_SERVICE_TYPE=FEDEX_INTERNATIONAL_PRIORITY
# Enabled by default. Logs complete outbound FedEx business payloads; OAuth secrets/tokens are never logged.
# Set false to disable FedEx outbound payload logs.
FEDEX_LOG_PAYLOADS=false
# Only for FedEx child-account integrations.
FEDEX_CHILD_KEY=
FEDEX_CHILD_SECRET=
FEDEX_REQUEST_TIMEOUT_MS=10000
```

Example request to the existing rate calculator (send the app's normal Bearer JWT):

```json
{
  "pickupCountry": "UAE",
  "pickupPincode": "00000",
  "destinationCountry": "USA",
  "destinationPincode": "10001",
  "actualWeight": 2.5,
  "length": 30,
  "breadth": 20,
  "height": 15
}
```

The integration caches the OAuth token in process memory and adds live FedEx service quotes to the rate calculator response. FedEx credentials stay server-side and are never returned to the client.

Country values can be ISO-2 codes (such as `AE`) or one of the configured calculator names, including `UAE`, `UK`, `USA`, and `SAUDI`.

## Shipment creation

The existing `POST /api/shipping/order` endpoint creates a real FedEx shipment when the selected carrier is `FedEx`. Send the `serviceType` and `packagingType` returned by the rate calculator in the selected `carrier` object. The order must also include full pickup and destination addresses (`streetLine1`, `city`, and phone number); international shipments additionally require `shipmentValue` and at least one product with a description and value.

On success, the stored order AWB is the FedEx tracking number. The FedEx PDF label is saved in the `order-documents` Supabase bucket at `orders/<tracking-number>/fedex-label.pdf`; its public URL is returned at `carrier.fedexShipment.labelUrl` and stored in the order data. FedEx API validation errors are passed back to the client without creating the local order.
