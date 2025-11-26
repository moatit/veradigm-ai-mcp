# FHIR Resources Reference

## Overview

The Veradigm FHIR MCP Server supports FHIR Release 4 (R4) standard and provides read-only access to various healthcare resources. This document outlines the supported resources, their search parameters, and data mappings.

## Supported FHIR Resources

### Patient
**Resource Type**: `Patient`
**Description**: Demographics and administrative information about individuals receiving care.

**Search Parameters**:
- `name`: Search by patient name
- `family`: Search by family name
- `given`: Search by given name
- `birthdate`: Search by birth date
- `gender`: Search by gender
- `telecom`: Search by phone/email
- `identifier`: Search by MRN or other identifiers

**Key Data Elements**:
- `id`: Patient resource ID
- `name`: Patient name (given, family)
- `birthDate`: Date of birth
- `gender`: Gender (male, female, other, unknown)
- `telecom`: Contact information (phone, email)
- `address`: Physical address
- `identifier`: Medical record numbers
- `active`: Whether patient record is active

### Appointment
**Resource Type**: `Appointment`
**Description**: Information about healthcare appointments.

**Search Parameters**:
- `patient`: Filter by patient ID
- `date`: Filter by date range
- `status`: Filter by appointment status
- `practitioner`: Filter by practitioner ID
- `location`: Filter by location ID

**Key Data Elements**:
- `id`: Appointment resource ID
- `status`: Appointment status (proposed, pending, booked, arrived, fulfilled, cancelled, noshow, entered-in-error, checked-in, waitlist)
- `start`: Appointment start time
- `end`: Appointment end time
- `participant`: Participants (patient, practitioner, location)
- `description`: Appointment description
- `serviceType`: Type of service

### MedicationRequest
**Resource Type**: `MedicationRequest`
**Description**: Requests for medications for patients.

**Search Parameters**:
- `patient`: Filter by patient ID
- `status`: Filter by request status
- `intent`: Filter by request intent
- `medication`: Filter by medication

**Key Data Elements**:
- `id`: Medication request ID
- `status`: Request status (draft, active, on-hold, revoked, completed, entered-in-error, unknown)
- `intent`: Request intent (proposal, plan, order, original-order, reflex-order, filler-order, instance-order, option)
- `medication`: Medication information
- `subject`: Patient reference
- `authoredOn`: When request was authored
- `requester`: Prescriber information
- `dosageInstruction`: Dosage instructions

### MedicationStatement
**Resource Type**: `MedicationStatement`
**Description**: Historical record of medication use.

**Search Parameters**:
- `patient`: Filter by patient ID
- `status`: Filter by statement status
- `medication`: Filter by medication

**Key Data Elements**:
- `id`: Statement ID
- `status`: Statement status (active, completed, entered-in-error, intended, stopped, on-hold, unknown, not-taken)
- `medication`: Medication information
- `subject`: Patient reference
- `effectivePeriod`: Period of medication use
- `dosage`: Dosage information
- `reasonCode`: Reason for medication

### Practitioner
**Resource Type**: `Practitioner`
**Description**: Healthcare providers/practitioners.

**Search Parameters**:
- `name`: Search by practitioner name
- `family`: Search by family name
- `given`: Search by given name
- `identifier`: Search by NPI or license number
- `specialty`: Search by medical specialty
- `active`: Filter by active status

**Key Data Elements**:
- `id`: Practitioner ID
- `name`: Practitioner name
- `identifier`: Professional identifiers (NPI, license)
- `qualification`: Medical qualifications and specialties
- `telecom`: Contact information
- `active`: Whether practitioner is active

### Location
**Resource Type**: `Location`
**Description**: Healthcare facilities and locations.

**Search Parameters**:
- `name`: Search by location name
- `address`: Search by address
- `type`: Search by location type
- `status`: Filter by location status

**Key Data Elements**:
- `id`: Location ID
- `name`: Location name
- `type`: Location type (hospital, clinic, pharmacy, etc.)
- `address`: Physical address
- `telecom`: Contact information
- `status`: Location status (active, suspended, inactive)
- `description`: Location description

### Condition
**Resource Type**: `Condition`
**Description**: Patient conditions and diagnoses.

**Search Parameters**:
- `patient`: Filter by patient ID
- `clinical-status`: Filter by clinical status
- `category`: Filter by condition category
- `code`: Filter by condition code

**Key Data Elements**:
- `id`: Condition ID
- `code`: Condition code and display
- `clinicalStatus`: Clinical status (active, recurrence, relapse, inactive, remission, resolved)
- `subject`: Patient reference
- `onsetDateTime`: Onset date
- `recordedDate`: When condition was recorded
- `severity`: Severity of condition

### AllergyIntolerance
**Resource Type**: `AllergyIntolerance`
**Description**: Patient allergies and intolerances.

**Search Parameters**:
- `patient`: Filter by patient ID
- `clinical-status`: Filter by allergy status
- `category`: Filter by allergy category
- `code`: Filter by substance code

**Key Data Elements**:
- `id`: Allergy ID
- `code`: Substance information
- `clinicalStatus`: Allergy status (active, inactive, resolved)
- `category`: Allergy categories (food, medication, environment, biologic)
- `patient`: Patient reference
- `onsetDateTime`: Onset date
- `severity`: Severity of allergy

### Observation
**Resource Type**: `Observation`
**Description**: Clinical observations (vitals, lab results, etc.).

**Search Parameters**:
- `patient`: Filter by patient ID
- `category`: Filter by observation category
- `code`: Filter by observation code
- `date`: Filter by date range
- `status`: Filter by observation status

**Key Data Elements**:
- `id`: Observation ID
- `code`: Observation code and display
- `subject`: Patient reference
- `valueQuantity`: Numeric value and unit
- `valueString`: String value
- `status`: Observation status (registered, preliminary, final, amended, corrected, cancelled, entered-in-error, unknown)
- `effectiveDateTime`: When observation was made
- `category`: Observation category (vital-signs, laboratory, imaging, survey, social-history)

### Procedure
**Resource Type**: `Procedure`
**Description**: Medical procedures performed on patients.

**Search Parameters**:
- `patient`: Filter by patient ID
- `status`: Filter by procedure status
- `category`: Filter by procedure category
- `date`: Filter by date range
- `code`: Filter by procedure code

**Key Data Elements**:
- `id`: Procedure ID
- `code`: Procedure code and display
- `status`: Procedure status (preparation, in-progress, not-done, on-hold, stopped, completed, entered-in-error, unknown)
- `subject`: Patient reference
- `performedDateTime`: When procedure was performed
- `performedPeriod`: Period of procedure
- `category`: Procedure category
- `reasonCode`: Reason for procedure

### Coverage
**Resource Type**: `Coverage`
**Description**: Insurance coverage information.

**Search Parameters**:
- `beneficiary`: Filter by patient ID
- `status`: Filter by coverage status
- `type`: Filter by coverage type

**Key Data Elements**:
- `id`: Coverage ID
- `status`: Coverage status (active, cancelled, draft, entered-in-error)
- `type`: Coverage type
- `beneficiary`: Patient reference
- `subscriberId`: Subscriber identifier
- `payor`: Insurance company
- `period`: Coverage period

## USCDI Compliance

The server supports United States Core Data for Interoperability (USCDI) guidelines:

### USCDI Data Classes Supported

1. **Patient Demographics**
   - Name, date of birth, gender
   - Address, phone, email
   - Race, ethnicity

2. **Clinical Notes**
   - Progress notes
   - Discharge summaries
   - Consultation notes

3. **Allergies and Intolerances**
   - Allergen information
   - Reaction information
   - Severity levels

4. **Medications**
   - Medication lists
   - Medication history
   - Dosage information

5. **Vital Signs**
   - Blood pressure
   - Heart rate
   - Temperature
   - Respiratory rate

6. **Laboratory**
   - Lab results
   - Lab values
   - Reference ranges

7. **Problems**
   - Active problems
   - Problem lists
   - Problem status

8. **Procedures**
   - Procedure history
   - Procedure codes
   - Procedure dates

9. **Immunizations**
   - Immunization history
   - Vaccine information
   - Immunization dates

10. **Encounters**
    - Visit information
    - Encounter types
    - Encounter dates

## Data Element Mappings

### Patient Data Mapping

| FHIR Element | MCP Response | Description |
|--------------|--------------|-------------|
| `name.given[0]` | `firstName` | Patient first name |
| `name.family` | `lastName` | Patient last name |
| `birthDate` | `birthDate` | Date of birth |
| `gender` | `gender` | Patient gender |
| `telecom[phone]` | `phone` | Phone number |
| `telecom[email]` | `email` | Email address |
| `address[0]` | `address` | Formatted address |
| `identifier[MRN]` | `mrn` | Medical record number |
| `active` | `active` | Record active status |

### Appointment Data Mapping

| FHIR Element | MCP Response | Description |
|--------------|--------------|-------------|
| `id` | `id` | Appointment ID |
| `status` | `status` | Appointment status |
| `start` | `start` | Start time |
| `end` | `end` | End time |
| `participant[patient]` | `patientId` | Patient ID |
| `participant[practitioner]` | `practitionerId` | Practitioner ID |
| `participant[location]` | `locationId` | Location ID |
| `description` | `description` | Appointment description |
| `serviceType[0]` | `serviceType` | Service type |

### Medication Data Mapping

| FHIR Element | MCP Response | Description |
|--------------|--------------|-------------|
| `id` | `id` | Medication request ID |
| `status` | `status` | Request status |
| `intent` | `intent` | Request intent |
| `medication` | `medicationName` | Medication name |
| `subject` | `patientId` | Patient ID |
| `authoredOn` | `authoredOn` | Request date |
| `requester` | `prescriberName` | Prescriber name |
| `dosageInstruction[0]` | `dosage` | Dosage information |

## Search Parameter Examples

### Patient Search Examples

```javascript
// Search by name
GET /Patient?name=Smith

// Search by birth date
GET /Patient?birthdate=1990-01-01

// Search by phone
GET /Patient?telecom=555-123-4567

// Search by MRN
GET /Patient?identifier=MRN123456

// Combined search
GET /Patient?family=Smith&given=John&birthdate=1990-01-01
```

### Appointment Search Examples

```javascript
// Get patient appointments
GET /Appointment?patient=patient-123

// Get appointments by date range
GET /Appointment?date=ge2024-01-01&date=le2024-12-31

// Get appointments by status
GET /Appointment?status=booked

// Get appointments by practitioner
GET /Appointment?practitioner=practitioner-456
```

### Medication Search Examples

```javascript
// Get patient medications
GET /MedicationRequest?patient=patient-123

// Get active medications
GET /MedicationRequest?patient=patient-123&status=active

// Get medications by intent
GET /MedicationRequest?patient=patient-123&intent=order

// Get specific medication
GET /MedicationRequest?patient=patient-123&medication=Lisinopril
```

## Pagination Support

All search operations support pagination:

### Pagination Parameters

- `_count`: Number of results per page (default: 20, max: 100)
- `_page`: Page number (1-based)
- `_offset`: Number of results to skip

### Pagination Response

```json
{
  "resourceType": "Bundle",
  "type": "searchset",
  "total": 150,
  "entry": [...],
  "link": [
    {
      "relation": "self",
      "url": "https://fhir.example.com/Patient?_count=20&_page=1"
    },
    {
      "relation": "next",
      "url": "https://fhir.example.com/Patient?_count=20&_page=2"
    }
  ]
}
```

## Error Handling

### Common FHIR Errors

1. **400 Bad Request**
   - Invalid search parameters
   - Malformed requests
   - Unsupported parameters

2. **401 Unauthorized**
   - Invalid or expired token
   - Missing authentication
   - Insufficient permissions

3. **403 Forbidden**
   - Access denied
   - Insufficient scopes
   - Resource restrictions

4. **404 Not Found**
   - Resource doesn't exist
   - Invalid resource ID
   - Deleted resource

5. **429 Too Many Requests**
   - Rate limit exceeded
   - Too many concurrent requests
   - Quota exceeded

### Error Response Format

```json
{
  "resourceType": "OperationOutcome",
  "issue": [
    {
      "severity": "error",
      "code": "invalid",
      "details": {
        "text": "Invalid search parameter: 'invalidParam'"
      }
    }
  ]
}
```

## Performance Considerations

### Optimization Tips

1. **Use Specific Search Parameters**
   - Avoid broad searches when possible
   - Use date ranges for time-based queries
   - Filter by status when appropriate

2. **Limit Result Sets**
   - Use `_count` parameter to limit results
   - Implement pagination for large datasets
   - Cache frequently accessed data

3. **Batch Operations**
   - Group related queries when possible
   - Use parallel requests for independent data
   - Implement request queuing for rate limits

### Rate Limiting

- Default rate limit: 100 requests per minute
- Burst limit: 20 requests per second
- Token refresh: Automatic with exponential backoff
- Retry logic: Built-in with configurable retry attempts

## Security Considerations

### Data Privacy

- All data access is logged for audit purposes
- Patient data is never cached in plain text
- Sensitive fields are masked in logs
- Access is restricted to authorized applications only

### Authentication

- OAuth 2.0 client credentials flow
- Token-based authentication
- Automatic token refresh
- Secure credential storage

### Compliance

- HIPAA compliant data handling
- SOC 2 Type II certified infrastructure
- Regular security audits
- Data encryption in transit and at rest




