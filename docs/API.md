# Veradigm FHIR MCP Server - API Reference

## Overview

The Veradigm FHIR MCP Server exposes 20+ read-only FHIR operations as MCP tools for AI voice agent integration. All tools follow FHIR R4 standards and provide structured responses optimized for AI consumption.

## Authentication

All tools require OAuth 2.0 client credentials authentication. The server automatically handles token acquisition and refresh.

## Tool Categories

### Patient Operations

#### `search_patient`
Search for patients by various criteria.

**Parameters:**
- `name` (string, optional): Full name to search for
- `firstName` (string, optional): First name to search for
- `lastName` (string, optional): Last name to search for
- `birthDate` (string, optional): Birth date in YYYY-MM-DD format
- `gender` (string, optional): Gender filter (male, female, other, unknown)
- `phone` (string, optional): Phone number to search for
- `email` (string, optional): Email address to search for
- `mrn` (string, optional): Medical Record Number
- `limit` (number, optional): Maximum results (default: 20)

**Response:**
```json
{
  "patients": [
    {
      "id": "patient-123",
      "name": "John Doe",
      "firstName": "John",
      "lastName": "Doe",
      "birthDate": "1990-01-01",
      "gender": "male",
      "phone": "555-123-4567",
      "email": "john.doe@email.com",
      "address": "123 Main St, City, ST 12345",
      "mrn": "MRN123456",
      "active": true
    }
  ],
  "total": 1,
  "hasMore": false
}
```

#### `get_patient_details`
Get detailed information for a specific patient.

**Parameters:**
- `patientId` (string, required): FHIR Patient resource ID

**Response:**
```json
{
  "id": "patient-123",
  "name": "John Doe",
  "firstName": "John",
  "lastName": "Doe",
  "birthDate": "1990-01-01",
  "gender": "male",
  "phone": "555-123-4567",
  "email": "john.doe@email.com",
  "address": "123 Main St, City, ST 12345",
  "mrn": "MRN123456",
  "active": true
}
```

#### `verify_patient_identity`
Verify patient identity by matching provided information.

**Parameters:**
- `firstName` (string, optional): Patient first name
- `lastName` (string, optional): Patient last name
- `birthDate` (string, optional): Birth date in YYYY-MM-DD format
- `phone` (string, optional): Phone number
- `email` (string, optional): Email address
- `mrn` (string, optional): Medical Record Number

**Response:**
```json
{
  "verified": true,
  "patient": {
    "id": "patient-123",
    "name": "John Doe",
    "firstName": "John",
    "lastName": "Doe",
    "birthDate": "1990-01-01",
    "gender": "male",
    "phone": "555-123-4567",
    "email": "john.doe@email.com",
    "address": "123 Main St, City, ST 12345",
    "mrn": "MRN123456",
    "active": true
  },
  "matchScore": 0.95,
  "suggestions": []
}
```

### Appointment Operations

#### `get_upcoming_appointments`
Get upcoming appointments for a patient.

**Parameters:**
- `patientId` (string, required): FHIR Patient resource ID
- `startDate` (string, optional): Start date in YYYY-MM-DD format
- `endDate` (string, optional): End date in YYYY-MM-DD format
- `status` (string, optional): Appointment status filter
- `limit` (number, optional): Maximum results (default: 20)

**Response:**
```json
{
  "appointments": [
    {
      "id": "appointment-123",
      "patientId": "patient-123",
      "patientName": "John Doe",
      "practitionerId": "practitioner-456",
      "practitionerName": "Dr. Smith",
      "locationId": "location-789",
      "locationName": "Main Clinic",
      "start": "2024-02-15T10:00:00Z",
      "end": "2024-02-15T10:30:00Z",
      "status": "booked",
      "description": "Annual checkup",
      "serviceType": "General Practice"
    }
  ],
  "total": 1,
  "hasMore": false
}
```

#### `get_appointment_details`
Get details for a specific appointment.

**Parameters:**
- `appointmentId` (string, required): FHIR Appointment resource ID

**Response:**
```json
{
  "id": "appointment-123",
  "patientId": "patient-123",
  "patientName": "John Doe",
  "practitionerId": "practitioner-456",
  "practitionerName": "Dr. Smith",
  "locationId": "location-789",
  "locationName": "Main Clinic",
  "start": "2024-02-15T10:00:00Z",
  "end": "2024-02-15T10:30:00Z",
  "status": "booked",
  "description": "Annual checkup",
  "serviceType": "General Practice"
}
```

#### `check_appointment_status`
Check the current status of a specific appointment.

**Parameters:**
- `appointmentId` (string, required): FHIR Appointment resource ID

**Response:**
```json
{
  "appointmentId": "appointment-123",
  "status": "booked",
  "start": "2024-02-15T10:00:00Z",
  "end": "2024-02-15T10:30:00Z",
  "patientName": "John Doe",
  "practitionerName": "Dr. Smith",
  "locationName": "Main Clinic",
  "description": "Annual checkup"
}
```

#### `find_patient_next_appointment`
Find the next scheduled appointment for a patient.

**Parameters:**
- `patientId` (string, required): FHIR Patient resource ID

**Response:**
```json
{
  "appointment": {
    "id": "appointment-123",
    "patientId": "patient-123",
    "patientName": "John Doe",
    "practitionerId": "practitioner-456",
    "practitionerName": "Dr. Smith",
    "locationId": "location-789",
    "locationName": "Main Clinic",
    "start": "2024-02-15T10:00:00Z",
    "end": "2024-02-15T10:30:00Z",
    "status": "booked",
    "description": "Annual checkup",
    "serviceType": "General Practice"
  },
  "found": true
}
```

#### `get_appointments_by_date_range`
Get appointments within a specific date range.

**Parameters:**
- `startDate` (string, required): Start date in YYYY-MM-DD format
- `endDate` (string, required): End date in YYYY-MM-DD format
- `practitionerId` (string, optional): Practitioner ID filter
- `locationId` (string, optional): Location ID filter
- `status` (string, optional): Status filter
- `limit` (number, optional): Maximum results (default: 50)

**Response:**
```json
{
  "appointments": [
    {
      "id": "appointment-123",
      "patientId": "patient-123",
      "patientName": "John Doe",
      "practitionerId": "practitioner-456",
      "practitionerName": "Dr. Smith",
      "locationId": "location-789",
      "locationName": "Main Clinic",
      "start": "2024-02-15T10:00:00Z",
      "end": "2024-02-15T10:30:00Z",
      "status": "booked",
      "description": "Annual checkup",
      "serviceType": "General Practice"
    }
  ],
  "total": 1,
  "hasMore": false
}
```

### Medication Operations

#### `get_patient_medications`
Get active medications for a patient.

**Parameters:**
- `patientId` (string, required): FHIR Patient resource ID
- `status` (string, optional): Medication status filter
- `intent` (string, optional): Medication intent filter
- `limit` (number, optional): Maximum results (default: 20)

**Response:**
```json
{
  "medications": [
    {
      "id": "medication-123",
      "patientId": "patient-123",
      "medicationName": "Lisinopril 10mg",
      "status": "active",
      "intent": "order",
      "authoredOn": "2024-01-15T09:00:00Z",
      "dosage": "10mg once daily",
      "instructions": "Take with food",
      "prescriberId": "practitioner-456",
      "prescriberName": "Dr. Smith"
    }
  ],
  "total": 1,
  "hasMore": false
}
```

#### `get_medication_requests`
Get medication requests for a patient.

**Parameters:**
- `patientId` (string, required): FHIR Patient resource ID
- `status` (string, optional): Request status filter
- `intent` (string, optional): Request intent filter
- `medication` (string, optional): Medication name filter
- `limit` (number, optional): Maximum results (default: 20)

**Response:**
```json
{
  "requests": [
    {
      "id": "medication-123",
      "patientId": "patient-123",
      "medicationName": "Lisinopril 10mg",
      "status": "active",
      "intent": "order",
      "authoredOn": "2024-01-15T09:00:00Z",
      "dosage": "10mg once daily",
      "instructions": "Take with food",
      "prescriberId": "practitioner-456",
      "prescriberName": "Dr. Smith"
    }
  ],
  "total": 1,
  "hasMore": false
}
```

#### `check_refill_status`
Check refill status for patient medications (read-only indicator).

**Parameters:**
- `patientId` (string, required): FHIR Patient resource ID
- `medicationName` (string, optional): Specific medication name

**Response:**
```json
{
  "patientId": "patient-123",
  "medications": [
    {
      "medicationName": "Lisinopril 10mg",
      "status": "active",
      "intent": "order",
      "authoredOn": "2024-01-15T09:00:00Z",
      "canRefill": true,
      "refillInfo": "Eligible for refill"
    }
  ]
}
```

#### `get_medication_statements`
Get medication statements (historical medication use).

**Parameters:**
- `patientId` (string, required): FHIR Patient resource ID
- `status` (string, optional): Statement status filter
- `limit` (number, optional): Maximum results (default: 20)

**Response:**
```json
{
  "statements": [
    {
      "id": "statement-123",
      "patientId": "patient-123",
      "medicationName": "Lisinopril 10mg",
      "status": "active",
      "effectivePeriod": {
        "start": "2024-01-15T09:00:00Z",
        "end": null
      },
      "dosage": "10mg once daily",
      "reason": "Hypertension"
    }
  ],
  "total": 1,
  "hasMore": false
}
```

### Provider Operations

#### `search_providers`
Search for healthcare providers/practitioners.

**Parameters:**
- `name` (string, optional): Full name to search for
- `firstName` (string, optional): First name to search for
- `lastName` (string, optional): Last name to search for
- `specialty` (string, optional): Medical specialty filter
- `identifier` (string, optional): Provider identifier (NPI, license)
- `active` (boolean, optional): Active status filter
- `limit` (number, optional): Maximum results (default: 20)

**Response:**
```json
{
  "providers": [
    {
      "id": "practitioner-456",
      "name": "Dr. Jane Smith",
      "firstName": "Jane",
      "lastName": "Smith",
      "specialty": ["Internal Medicine", "Cardiology"],
      "phone": "555-987-6543",
      "email": "jane.smith@clinic.com",
      "active": true
    }
  ],
  "total": 1,
  "hasMore": false
}
```

#### `get_provider_details`
Get detailed information for a specific provider.

**Parameters:**
- `providerId` (string, required): FHIR Practitioner resource ID

**Response:**
```json
{
  "id": "practitioner-456",
  "name": "Dr. Jane Smith",
  "firstName": "Jane",
  "lastName": "Smith",
  "specialty": ["Internal Medicine", "Cardiology"],
  "phone": "555-987-6543",
  "email": "jane.smith@clinic.com",
  "active": true
}
```

#### `search_locations`
Search for healthcare facilities/locations.

**Parameters:**
- `name` (string, optional): Location name to search for
- `address` (string, optional): Address to search for
- `type` (string, optional): Location type filter
- `status` (string, optional): Location status filter
- `limit` (number, optional): Maximum results (default: 20)

**Response:**
```json
{
  "locations": [
    {
      "id": "location-789",
      "name": "Main Clinic",
      "address": "123 Medical Center Dr, City, ST 12345",
      "type": "Hospital",
      "status": "active",
      "phone": "555-555-1234",
      "email": "info@mainclinic.com"
    }
  ],
  "total": 1,
  "hasMore": false
}
```

#### `get_location_details`
Get detailed information for a specific location.

**Parameters:**
- `locationId` (string, required): FHIR Location resource ID

**Response:**
```json
{
  "id": "location-789",
  "name": "Main Clinic",
  "address": "123 Medical Center Dr, City, ST 12345",
  "type": "Hospital",
  "status": "active",
  "phone": "555-555-1234",
  "email": "info@mainclinic.com",
  "description": "Primary care facility"
}
```

### Clinical Operations

#### `get_patient_conditions`
Get patient conditions/diagnoses.

**Parameters:**
- `patientId` (string, required): FHIR Patient resource ID
- `status` (string, optional): Clinical status filter
- `category` (string, optional): Condition category filter
- `limit` (number, optional): Maximum results (default: 20)

**Response:**
```json
{
  "conditions": [
    {
      "id": "condition-123",
      "patientId": "patient-123",
      "code": "I10",
      "display": "Essential hypertension",
      "status": "active",
      "onsetDate": "2023-06-01",
      "recordedDate": "2023-06-01T10:00:00Z",
      "severity": "Moderate"
    }
  ],
  "total": 1,
  "hasMore": false
}
```

#### `get_allergies`
Get patient allergies and intolerances.

**Parameters:**
- `patientId` (string, required): FHIR Patient resource ID
- `status` (string, optional): Allergy status filter
- `category` (string, optional): Allergy category filter
- `limit` (number, optional): Maximum results (default: 20)

**Response:**
```json
{
  "allergies": [
    {
      "id": "allergy-123",
      "patientId": "patient-123",
      "substance": "Penicillin",
      "status": "active",
      "category": ["medication"],
      "severity": "Severe",
      "onsetDate": "2020-03-15T14:30:00Z"
    }
  ],
  "total": 1,
  "hasMore": false
}
```

#### `get_recent_observations`
Get recent observations (vitals, lab results, etc.).

**Parameters:**
- `patientId` (string, required): FHIR Patient resource ID
- `category` (string, optional): Observation category filter
- `code` (string, optional): Specific observation code
- `dateFrom` (string, optional): Start date in YYYY-MM-DD format
- `dateTo` (string, optional): End date in YYYY-MM-DD format
- `limit` (number, optional): Maximum results (default: 20)

**Response:**
```json
{
  "observations": [
    {
      "id": "observation-123",
      "patientId": "patient-123",
      "code": "8480-6",
      "display": "Systolic blood pressure",
      "value": "120 mmHg",
      "unit": "mmHg",
      "status": "final",
      "effectiveDateTime": "2024-01-15T10:00:00Z",
      "category": "vital-signs"
    }
  ],
  "total": 1,
  "hasMore": false
}
```

#### `get_patient_procedures`
Get patient procedures.

**Parameters:**
- `patientId` (string, required): FHIR Patient resource ID
- `status` (string, optional): Procedure status filter
- `category` (string, optional): Procedure category filter
- `dateFrom` (string, optional): Start date in YYYY-MM-DD format
- `dateTo` (string, optional): End date in YYYY-MM-DD format
- `limit` (number, optional): Maximum results (default: 20)

**Response:**
```json
{
  "procedures": [
    {
      "id": "procedure-123",
      "patientId": "patient-123",
      "code": "99213",
      "display": "Office visit, established patient",
      "status": "completed",
      "performedDateTime": "2024-01-15T10:00:00Z",
      "performedPeriod": {
        "start": "2024-01-15T10:00:00Z",
        "end": "2024-01-15T10:30:00Z"
      },
      "category": "Office Visit",
      "reason": "Annual checkup"
    }
  ],
  "total": 1,
  "hasMore": false
}
```

#### `get_patient_coverage`
Get patient insurance coverage information.

**Parameters:**
- `patientId` (string, required): FHIR Patient resource ID
- `status` (string, optional): Coverage status filter
- `limit` (number, optional): Maximum results (default: 10)

**Response:**
```json
{
  "coverage": [
    {
      "id": "coverage-123",
      "patientId": "patient-123",
      "status": "active",
      "type": "Primary Insurance",
      "subscriberId": "SUB123456",
      "payor": "Blue Cross Blue Shield",
      "period": {
        "start": "2024-01-01",
        "end": "2024-12-31"
      }
    }
  ],
  "total": 1,
  "hasMore": false
}
```

## Error Handling

All tools return structured error responses:

```json
{
  "error": "VALIDATION_ERROR",
  "message": "Patient ID is required",
  "details": {
    "field": "patientId",
    "expected": "string"
  },
  "timestamp": "2024-01-15T10:00:00Z"
}
```

### Error Codes

- `AUTH_ERROR`: Authentication failure
- `FHIR_ERROR`: FHIR API error
- `VALIDATION_ERROR`: Input validation error
- `NOT_FOUND`: Resource not found
- `RATE_LIMIT`: Rate limit exceeded
- `NETWORK_ERROR`: Network connectivity issue
- `UNKNOWN_ERROR`: Unexpected error

## Rate Limiting

The server implements automatic rate limiting and token refresh. If rate limits are exceeded, the server will automatically retry with exponential backoff.

## Pagination

Most list operations support pagination through the `limit` parameter. Responses include:
- `total`: Total number of results
- `hasMore`: Whether more results are available
- `nextUrl`: URL for next page (if available)

## Data Formats

All dates are returned in ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ).
All FHIR resource IDs are returned as strings.
Phone numbers and addresses are formatted for display.




