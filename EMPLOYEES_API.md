# Employees and admin page access

Apply `migrations/add-employees.sql` in Supabase before deploying. The employee role is `employee`, distinct from customer `organization_role = employee`. Public registration continues to create only regular users.

This repository is the backend only. The frontend must add employee management for admins, use the page catalog to render permission checkboxes, and guard navigation/direct page URLs using `user.page_permissions`. An employee with no permissions should see an access-not-assigned screen. Admins retain every permission.

All management endpoints require an admin Bearer token (or the existing server-only `x-admin-token`). Employees cannot manage employees, even with Users access.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/admin/employees/pages` | Nine page keys and display labels |
| GET | `/api/admin/employees` | List employees |
| POST | `/api/admin/employees` | Create employee |
| GET | `/api/admin/employees/:id` | Employee details |
| PATCH | `/api/admin/employees/:id` | Edit profile, password, or permissions |
| DELETE | `/api/admin/employees/:id` | Delete employee |

Example create body:

```json
{
  "name": "Alex Smith",
  "email": "alex@example.com",
  "password": "initial-password-123",
  "page_permissions": ["customers", "rate_calculator", "user_orders"]
}
```

`name`, `email`, and `password` are required on creation. `company_name` is optional. Passwords must contain at least 8 characters and at most 72 UTF-8 bytes; only bcrypt hashes are stored. Omit password on PATCH to keep it unchanged. `page_permissions` replaces the complete permission set; `[]` revokes all access. Omitted permissions default to none on create and stay unchanged on edit. Unknown fields and page keys are rejected. Responses never contain passwords or hashes.

Employees log in with `/api/auth/login`. Login, `/api/auth/me`, and `/api/auth/verify-token` return the role and effective `page_permissions`. The backend reloads permissions on every authenticated request, so revocation takes effect with the existing token. Deleted accounts cannot authenticate. Deletion returns 409 if existing database foreign keys require retaining the employee's linked records.

| Key | Page / API |
| --- | --- |
| `customers` | Customers (`/api/customers`) |
| `rate_calculator` | Rate calculator and saved calculations |
| `create_order` | Order creation, address forms, contact/box details, AI extraction |
| `users` | Admin user lists and details |
| `home` | Home and notifications |
| `user_orders` | Order details, orders by user, pickups |
| `kyc_requests` | KYC requests and status updates |
| `billing` | Billing uploads and listing |
| `tickets` | Ticket administration and messages |

Page access permits the existing read/write actions on that page. Quote/location lookups are shared between Rate calculator and Create order; customer suggestions/details are shared with Create order. Home has no dedicated dashboard API in this repository. Existing customer ownership rules remain unless the endpoint already has an admin path, which authorized employees can now use. Frontend dashboard widgets must respect the permissions for their data sources as well as Home.

Both `POST /api/shipping/quote` and `POST /api/shipping/quote/validated` now require a Bearer token so employee page restrictions cannot be bypassed through anonymous quote calls. Update callers to send their login token. Public address-form links and public location suggestions retain their existing behavior.
