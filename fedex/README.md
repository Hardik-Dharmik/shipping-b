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

Each FedEx quote's `costBreakdown` now exposes two separate sections:

- `fedexCharges`: the live FedEx quote (`baseShippingCharge`, `surchargesTotal`, individual `surchargeDetails`, and `totalQuotedCharge`).
- `internalCharges`: fees added by this application, including BOE, DO, temporary export, export declaration, insurance, and other charges. Its `total` is added to the FedEx total to produce `cost` / `totalCost`.

The existing flat `baseShippingCost`, `complianceCharges`, `additionalCharges`, and `fedexSurcharges` fields remain available for older clients.

## Create-order package options

When the selected carrier is FedEx, submit the selected values in `fedexOptions` (or `carrier.fedexOptions`) with the existing `POST /api/shipping/order` endpoint:

```json
{
  "fedexOptions": {
    "lithiumBatteryTypes": ["LITHIUM_ION_CONTAINED_IN_EQUIPMENT"],
    "dangerousGoods": {
      "type": "ADG",
      "cargoAircraftOnly": false
    }
  }
}
```

`lithiumBatteryTypes` supports the four FedEx Section II options shown in the UI: lithium metal/ion, each contained in or packed with equipment. These are sent as FedEx package-level `BATTERY` special services using `IATA_SECTION_II`. `dangerousGoods.type` accepts `ADG` (accessible) or `IDG` (inaccessible) and is sent as a `DANGEROUS_GOODS` special service for every package.

FedEx account approval, the selected service/lane, IATA classification, packaging, markings, and any required dangerous-goods declaration remain mandatory. The application forwards the selection; FedEx is the final validator for whether that shipment may be created.

Country values can be ISO-2 codes (such as `AE`) or one of the configured calculator names, including `UAE`, `UK`, `USA`, and `SAUDI`.

## Shipment creation

The existing `POST /api/shipping/order` endpoint creates a real FedEx shipment when the selected carrier is `FedEx`. Send the `serviceType` and `packagingType` returned by the rate calculator in the selected `carrier` object. The order must also include full pickup and destination addresses (`streetLine1`, `city`, and phone number); international shipments additionally require `shipmentValue` and at least one product with a description and value.

On success, the stored order AWB is the FedEx tracking number. The FedEx PDF label is saved in the `order-documents` Supabase bucket at `orders/<tracking-number>/fedex-label.pdf`; its public URL is returned at `carrier.fedexShipment.labelUrl` and stored in the order data. FedEx API validation errors are passed back to the client without creating the local order.

## Pickup scheduling

Enable the **Pickup Request API** for the same FedEx developer project that owns the credentials above, then run `migrations/add-pickups.sql` in Supabase.

Pickups can be requested along with `POST /api/shipping/order` by including `pickupRequest`, or after an order exists with `POST /api/shipping/pickups`. A standalone pickup must include `awbNumber`; the API rejects a second active pickup for the same AWB. For example:

```json
{
  "carrier": "FedEx",
  "awbNumber": "123456789012",
  "pickupDate": "2026-08-21",
  "readyTime": "09:00",
  "customerCloseTime": "17:00",
  "packageCount": 2,
  "totalWeight": 4.5,
  "pickupAddress": {
    "streetLine1": "123 Example Street",
    "city": "Dubai",
    "phoneNumber": "+971500000000"
  },
  "pickupCountry": "AE",
  "pickupPincode": "00000"
}
```

Use `GET /api/shipping/pickups` to show the signed-in user's saved pickups, `DELETE /api/shipping/pickups/:pickupId` to cancel, and `PUT /api/shipping/pickups/:pickupId` to edit. FedEx does not permit a pickup to be changed in place, so the edit endpoint cancels it with FedEx and creates a replacement record.
