# GLS Payment System - Backend API

## Overview
Node.js + Express REST API for Genetec Lifesciences Payment Management System.

## Tech Stack
- **Runtime:** Node.js 18+
- **Framework:** Express.js
- **Database:** PostgreSQL (DigitalOcean)
- **Authentication:** JWT
- **Validation:** express-validator

## Project Structure
```
backend/
├── src/
│   ├── config/
│   │   └── database.js      # PostgreSQL connection
│   ├── middleware/
│   │   ├── auth.middleware.js      # JWT authentication
│   │   ├── error.middleware.js     # Error handling
│   │   └── validation.middleware.js # Input validation
│   ├── routes/
│   │   ├── auth.routes.js      # Login, refresh, password
│   │   ├── vendor.routes.js    # Vendor CRUD + ledger
│   │   ├── customer.routes.js  # Customer CRUD
│   │   ├── inward.routes.js    # Inward bills (Godown)
│   │   ├── outward.routes.js   # Outward/Dispatch (Godown)
│   │   ├── proposal.routes.js  # Payment proposals (Purchase)
│   │   ├── payment.routes.js   # Payments & UTR (Accounts)
│   │   ├── dashboard.routes.js # Role-specific dashboards
│   │   └── report.routes.js    # Reports & ageing
│   └── index.js               # Main application
├── .env.example               # Environment template
├── package.json
└── README.md
```

## Setup

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your database credentials
```

### 3. Database Setup
Run the SQL files in `/database/` folder on your PostgreSQL:
```bash
psql -h your-host -U doadmin -d gls_payment_management -f ../database/001_schema.sql
psql -h your-host -U doadmin -d gls_payment_management -f ../database/002_seed_vendors.sql
psql -h your-host -U doadmin -d gls_payment_management -f ../database/003_seed_customers.sql
psql -h your-host -U doadmin -d gls_payment_management -f ../database/004_seed_users.sql
```

### 4. Start Server
```bash
# Development
npm run dev

# Production
npm start
```

## API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/login | User login |
| POST | /api/auth/refresh | Refresh token |
| GET | /api/auth/me | Current user |
| POST | /api/auth/change-password | Change password |

### Vendors
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/vendors | List vendors |
| GET | /api/vendors/dropdown | Simple list for dropdowns |
| GET | /api/vendors/:id | Get vendor with outstanding |
| GET | /api/vendors/:id/bills | Vendor's bills |
| GET | /api/vendors/:id/payments | Payment history |
| POST | /api/vendors | Create vendor |
| PUT | /api/vendors/:id | Update vendor |
| DELETE | /api/vendors/:id | Deactivate vendor |

### Customers
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/customers | List customers |
| GET | /api/customers/:id | Get customer |
| GET | /api/customers/:id/bills | Customer's bills |
| POST | /api/customers | Create customer |
| PUT | /api/customers/:id | Update customer |

### Inward Bills (Godown)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/inward | List bills with filters |
| GET | /api/inward/today | Today's entries |
| GET | /api/inward/by-date/:date | Entries by date |
| GET | /api/inward/summary | Summary stats |
| GET | /api/inward/:id | Get bill details |
| POST | /api/inward | Create bill |
| PUT | /api/inward/:id | Update bill (Owner only) |
| DELETE | /api/inward/:id | Cancel bill (Owner only) |

### Outward Bills (Godown)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/outward | List dispatches |
| GET | /api/outward/today | Today's dispatches |
| GET | /api/outward/receivables-ageing | Ageing summary |
| GET | /api/outward/overdue | Overdue list |
| POST | /api/outward | Create dispatch |
| PATCH | /api/outward/:id/delivery-status | Update delivery |

### Proposals (Purchase)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/proposals | List proposals |
| GET | /api/proposals/available-bills | Bills for proposal |
| GET | /api/proposals/:id | Get proposal |
| POST | /api/proposals | Create proposal |
| POST | /api/proposals/:id/submit | Submit for review |
| POST | /api/proposals/:id/accounts-action | Accounts validation |
| POST | /api/proposals/:id/owner-action | Owner approval |

### Payments (Accounts)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/payments | List payments |
| GET | /api/payments/by-date/:date | Payments by date |
| GET | /api/payments/pending-utr | Pending UTR entry |
| GET | /api/payments/:id | Payment details |
| POST | /api/payments/create-from-proposal | Create from proposal |
| POST | /api/payments/:id/update-utr | Update UTR numbers |
| GET | /api/payments/export-bank-file/:id | Export for bank |

### Dashboard
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/dashboard/godown | Godown stats |
| GET | /api/dashboard/purchase | Purchase stats |
| GET | /api/dashboard/accounts | Accounts stats |
| GET | /api/dashboard/owner | Owner stats |

### Reports
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/reports/payables-ageing | Vendor ageing |
| GET | /api/reports/receivables-ageing | Customer ageing |
| GET | /api/reports/payment-history | Payment history |
| GET | /api/reports/daily-summary | Daily summary |
| GET | /api/reports/cash-flow | Cash flow projection |

## Role Permissions

| Role | Permissions |
|------|-------------|
| **godown** | Create inward/outward bills, view own entries |
| **purchase** | Create proposals, view payment history, vendor ledger |
| **accounts** | Validate proposals, UTR entry, receivables |
| **owner** | All access, edit/delete, approvals |

## Authentication
All API requests (except login) require Bearer token:
```
Authorization: Bearer <jwt_token>
```

## Error Responses
```json
{
  "error": "Error type",
  "message": "Detailed message",
  "details": [] // For validation errors
}
```

## Default Users (from seed)
| Username | Password | Role |
|----------|----------|------|
| godown | password123 | godown |
| purchase | password123 | purchase |
| accounts | password123 | accounts |
| owner | password123 | owner |

## Environment Variables
```env
PORT=3000
NODE_ENV=development
DB_HOST=your-db-host
DB_PORT=25060
DB_NAME=gls_payment_management
DB_USER=doadmin
DB_PASSWORD=your-password
DB_SSL=true
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=24h
```
