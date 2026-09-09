# Customer API

Apply `migrations/add-customers.sql` in the Supabase SQL Editor before deploying.
Then apply `migrations/share-customers.sql` to enable shared customers.
The same schema is included in `database-schema.sql` for fresh databases.
The server must have `SUPABASE_SERVICE_ROLE_KEY` configured.

All endpoints below require `Authorization: Bearer <token>`, except the existing
public address-form submission endpoint. Customers are shared: all signed-in users can list, view, and select any customer.
Order visibility still follows the existing user/admin permissions.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/customers` | Create a customer |
| GET | `/api/customers?query=acme&page=1&limit=20` | Search/list customers; maximum limit 100 |
| GET | `/api/customers/suggestions?query=acme&limit=10` | Dropdown suggestions; maximum limit 20 |
| GET | `/api/customers/:id` | Retrieve one customer using its six-digit ID |
| POST | `/api/shipping/order` | Existing order creation; accepts `customerId` |
| POST | `/api/address/address-forms` | Existing address-link creation; accepts `customerId` |
| POST | `/api/address/address-forms/order-link` | Existing order-link creation; accepts `customerId` |
| GET | `/api/shipping/orders?customerId=100000` | Filter the signed-in user's orders |
| GET | `/api/shipping/orders/user/:userId?customerId=100000` | Filter a user's orders, with existing admin-only access |
| GET | `/api/shipping/orders/:orderId` | Existing order details; includes customer details in `data.order` |

Create a customer with this JSON body:

```json
{
  "companyName": "Acme Logistics",
  "email": "sales@acme.com",
  "phoneNumber": "+971 50 123 4567"
}
```

All three fields are required. Company names allow at most 200 characters;
phone numbers accept 7–15 digits with optional formatting. Creation returns HTTP 201:

```json
{
  "success": true,
  "data": {
    "id": "100000",
    "company_name": "Acme Logistics",
    "email": "sales@acme.com",
    "phone_number": "+971 50 123 4567",
    "created_at": "2026-09-09T10:00:00Z"
  }
}
```

IDs are database-generated strings from `100000` through `999999`. A noncycling
sequence and primary key prevent collisions during concurrent creation. Gaps are
possible; the finite six-digit space supports at most 900,000 sequence allocations.
Clients cannot choose the ID. The creating user is recorded for audit only.

List and suggestion responses use `data: [...]` with the same customer fields.
`query` searches company name, ID, email, and phone number. Omit it to retrieve
customers alphabetically. Lists also return `pagination` with `page`, `limit`,
`total`, and `totalPages`. Suggestions can supply both the order-entry dropdown
and the customer filter dropdown.

Send the selected customer's `id` as `customerId: "100000"` alongside existing
order fields. For multipart orders using the JSON `order` field, put `customerId`
inside that object. For order links, put it inside `order` (or `orderData`), or
at the top level. If both locations supply it, they must agree. For address-only
links, send `{ "customerId": "100000" }`.

Selection is optional for compatibility. Orders without a selection have
`customer_id: null`. When creating an order using `addressFormId`, the saved
customer is inherited; a conflicting selection returns HTTP 400. Public submission
at `POST /api/address/address-forms/public/:code` also inherits the saved customer
and ignores customer substitutions in the recipient's body.

Order lists and order details include:

```json
{
  "customer_id": "100000",
  "customer": {
    "id": "100000",
    "company_name": "Acme Logistics",
    "email": "sales@acme.com",
    "phone_number": "+971 50 123 4567"
  }
}
```

Use `customer.company_name` for the frontend order-list column and `customer.id`
for its identifier. Existing orders return `customer: null`. Customer filtering
combines with the existing search, status, carrier, date, and pagination parameters.
The repository is backend-only; the frontend must wire these dropdowns and column
to the endpoints above.

Invalid customer IDs return HTTP 400. Selecting an unknown customer returns HTTP 404. Database foreign keys enforce customer existence.

Run the mocked API tests with `node --test tests/customers.test.js`. They do not
connect to Supabase or create real carrier shipments.

## Reopening a completed link

`GET /api/address/address-forms/public/:code` requires no login. For a completed
link it returns HTTP 200 with `data.status: "ordered"`, `data.read_only: true`,
`data.order`, `data.pickup`, `data.costBreakdown`, and `data.carrierCostBreakdown`.
These detail fields match the authenticated order-details endpoint. The frontend
should render the order-details page instead of the address-entry form.
Completed links remain readable after form expiry; POST still rejects resubmission.
Only the order associated with that link and its account is retrieved. Anyone
with the link can view its order details. Open links keep their existing response.
