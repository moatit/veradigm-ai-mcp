# 📋 Complete List of MCP Tools

## Total: **21 Tools**

---

## 👤 Patient Tools (3 tools)

1. **`search_patient`**

   - Search for patients by name, birth date, phone, email, or MRN
   - Parameters: `name`, `firstName`, `lastName`, `birthDate`, `gender`, `phone`, `email`, `mrn`, `limit`

2. **`get_patient_details`**

   - Get detailed information for a specific patient by ID
   - Parameters: `patientId` (required)

3. **`verify_patient_identity`**
   - Verify patient identity by matching provided information against patient records
   - Parameters: `firstName`, `lastName`, `birthDate`, `phone`, `email`, `mrn`

---

## 📅 Appointment Tools (5 tools)

1. **`get_upcoming_appointments`**

   - Get upcoming appointments for a patient within a date range
   - Parameters: `patientId` (required), `startDate`, `endDate`, `status`, `limit`

2. **`get_appointment_details`**

   - Get detailed information for a specific appointment
   - Parameters: `appointmentId` (required)

3. **`check_appointment_status`**

   - Check the current status of a specific appointment
   - Parameters: `appointmentId` (required)

4. **`find_patient_next_appointment`**

   - Find the next scheduled appointment for a patient
   - Parameters: `patientId` (required)

5. **`get_appointments_by_date_range`**
   - Get appointments within a specific date range, optionally filtered by practitioner or location
   - Parameters: `startDate`, `endDate`, `practitionerId`, `locationId`, `status`, `limit`

---

## 💊 Medication Tools (4 tools)

1. **`get_patient_medications`**

   - Get active medications for a patient
   - Parameters: `patientId` (required), `status`, `intent`, `limit`

2. **`get_medication_requests`**

   - Get medication requests for a patient with optional filtering
   - Parameters: `patientId` (required), `status`, `intent`, `medication`, `limit`

3. **`check_refill_status`**

   - Check refill status for patient medications (read-only indicator)
   - Parameters: `patientId` (required), `medicationName`

4. **`get_medication_statements`**
   - Get medication statements (historical medication use) for a patient
   - Parameters: `patientId` (required), `status`, `limit`

---

## 👨‍⚕️ Provider Tools (4 tools)

1. **`search_providers`**

   - Search for healthcare providers/practitioners
   - Parameters: `name`, `firstName`, `lastName`, `specialty`, `identifier`, `active`, `limit`

2. **`get_provider_details`**

   - Get detailed information for a specific provider
   - Parameters: `providerId` (required)

3. **`search_locations`**

   - Search for healthcare facilities/locations
   - Parameters: `name`, `address`, `type`, `status`, `limit`

4. **`get_location_details`**
   - Get detailed information for a specific location
   - Parameters: `locationId` (required)

---

## 🏥 Clinical Tools (5 tools)

1. **`get_patient_conditions`**

   - Get patient conditions/diagnoses
   - Parameters: `patientId` (required), `status`, `category`, `limit`

2. **`get_allergies`**

   - Get patient allergies and intolerances
   - Parameters: `patientId` (required), `status`, `category`, `limit`

3. **`get_recent_observations`**

   - Get recent observations (vitals, lab results, etc.) for a patient
   - Parameters: `patientId` (required), `category`, `code`, `dateFrom`, `dateTo`, `limit`

4. **`get_patient_procedures`**

   - Get patient procedures
   - Parameters: `patientId` (required), `status`, `category`, `dateFrom`, `dateTo`, `limit`

5. **`get_patient_coverage`**
   - Get patient insurance coverage information
   - Parameters: `patientId` (required), `status`, `limit`

---

## 📊 Summary by Category

| Category    | Count  |
| ----------- | ------ |
| Patient     | 3      |
| Appointment | 5      |
| Medication  | 4      |
| Provider    | 4      |
| Clinical    | 5      |
| **TOTAL**   | **21** |

---

## 🎯 Most Commonly Used Tools

For a typical patient lookup flow:

1. **`search_patient`** - Find patient by name/MRN
2. **`get_patient_details`** - Get full patient information
3. **`get_upcoming_appointments`** - Show patient's schedule
4. **`get_patient_medications`** - Show current medications
5. **`get_recent_observations`** - Show recent vitals/labs

---

## 📝 Notes

- All tools require proper OAuth authentication
- Most tools require a `patientId` parameter (obtained from `search_patient`)
- Tools return FHIR R4 formatted data
- All tools support optional `limit` parameter for pagination
- Tools are read-only (no write operations)
