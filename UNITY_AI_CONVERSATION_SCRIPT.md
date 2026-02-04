# Unity Server — AI Conversation Script

Conversation script for testing the Retell/voice AI with **Unity MCP tools**. Use this reference patient for all flows.

---

## Reference patient (test user)

| Field | Value |
|-------|--------|
| **First name** | Nichole |
| **Last name** | Albanese |
| **Patient ID** | 764 |
| **MRN** | 29700 |
| **DOB** | 04/24/1928 |
| **Gender** | F |
| **Address** | 2748 Puckett St, Raleigh, NC 27511 |
| **Phone** | (919) 555-1874 |
| **Race / Ethnicity** | Undefined |

**Tool response example (get by MRN):**
```json
{
  "success": true,
  "patient": {
    "id": "764",
    "mrn": "29700",
    "firstName": "Nichole",
    "lastName": "Albanese",
    "dateOfBirth": "04/24/1928",
    "gender": "F",
    "address": { "line1": "2748 Puckett St ", "city": "Raleigh", "state": "NC   ", "zipCode": "27511" },
    "phone": { "home": "(919) 555-1874" },
    "race": "Undefined",
    "ethnicity": "Undefined"
  },
  "message": "Patient retrieved successfully"
}
```

---

## Conversation flow (step-by-step)

### 1. Greeting & identity

| Step | User says | AI should |
|------|-----------|-----------|
| 1 | *(AI speaks first)* | Greet and ask how to help (appointments, medications, details, etc.). |
| 2 | "I want my details." / "Pull my record." | Ask for first name, last name, and DOB **or** MRN. |
| 3a | "Nichole Albanese. April 24, 1928." | Call **unity_search_patients** with `firstName: "Nichole", lastName: "Albanese", dateOfBirth: "04/24/1928"`, then read back details (id 764, MRN 29700, address, phone). |
| 3b | "My MRN is 29700." / "Look up MRN two nine seven zero zero." | Call **unity_get_patient_by_mrn** with `mrn: "29700"`, then read back Nichole Albanese’s details. |

After identity, AI should have **patientId 764** for any later tool calls.

---

### 2. Patient tools (by tool)

| # | Tool | User says | AI should call |
|---|------|-----------|----------------|
| 1 | **unity_search_patients** | "Find me — Nichole Albanese, DOB April 24, 1928." | `unity_search_patients` with firstName, lastName, dateOfBirth (MM/DD/YYYY). |
| 2 | **unity_get_patient_by_mrn** | "Get my record by MRN 29700." | `unity_get_patient_by_mrn` with `mrn: "29700"`. |
| 3 | **unity_get_patient** | "Get my full patient details." *(after already found as 764)* | `unity_get_patient` with `patientId: "764"`. |

---

### 3. Clinical tools (use patientId 764)

| # | Tool | User says | AI should call |
|---|------|-----------|----------------|
| 4 | **unity_get_patient_medications** | "What medications am I on?" / "List my medications." | `unity_get_patient_medications` with `patientId: "764"`. |
| 5 | **unity_get_patient_problems** | "What are my medical problems?" / "My conditions?" | `unity_get_patient_problems` with `patientId: "764"`. |
| 6 | **unity_get_patient_allergies** | "Do I have any allergies?" | `unity_get_patient_allergies` with `patientId: "764"`. |
| 7 | **unity_get_patient_diagnosis** | "What are my diagnoses?" | `unity_get_patient_diagnosis` with `patientId: "764"`. |

---

### 4. Appointment tools (use patientId 764)

| # | Tool | User says | AI should call |
|---|------|-----------|----------------|
| 8 | **unity_get_patient_appointments** | "When are my appointments?" / "Show my appointments." | `unity_get_patient_appointments` with `patientId: "764"`. |
| 9 | **unity_get_open_slots** | "What times are available?" / "Find open slots next week." | `unity_get_open_slots` with `startDate`, `endDate` (MM/DD/YYYY). |
| 10 | **unity_save_appointment** | "Book me for [date] at [time]." | `unity_save_appointment` with patientId 764, appointmentDate, appointmentTime, duration (and optional provider/location/type/reason). |
| 11 | **unity_cancel_appointment** | "Cancel my appointment [ID or date/time]." | `unity_cancel_appointment` with `appointmentId`, `patientId: "764"`. |

---

### 5. Optional / admin tools

| # | Tool | User says | AI should call |
|---|------|-----------|----------------|
| 12 | **unity_save_patient** | *(Admin: create new patient)* | `unity_save_patient` with demographics. |
| 13 | **unity_update_demographics** | "Update my phone number." *(after identity)* | `unity_update_demographics` with patientId 764 and new fields. |

---

## Short phrases (copy-paste for testing)

Use these after the AI has identified the patient (Nichole Albanese, MRN 29700, ID 764).

- "Get my details by MRN 29700."
- "What are my medications?"
- "Do I have any allergies?"
- "What are my medical problems?"
- "What are my diagnoses?"
- "When are my appointments?"
- "Find open slots for next week."
- "Get my full patient record."

---

## Date/time format for tools

- **Dates:** MM/DD/YYYY (e.g. 04/24/1928, 01/15/2025).
- **Times:** HH:MM 24-hour (e.g. 14:00 for 2:00 PM).
- **Spoken:** "April 24, 1928" → 04/24/1928; "December 6, 1952" → 12/06/1952.

---

## Quick reference: all 13 Unity tools

| Purpose | Tool name |
|---------|-----------|
| Search patients (name + DOB) | unity_search_patients |
| Get patient by MRN | unity_get_patient_by_mrn |
| Get full patient | unity_get_patient |
| Medications | unity_get_patient_medications |
| Problems/conditions | unity_get_patient_problems |
| Allergies | unity_get_patient_allergies |
| Diagnoses | unity_get_patient_diagnosis |
| Patient appointments | unity_get_patient_appointments |
| Open slots | unity_get_open_slots |
| Book appointment | unity_save_appointment |
| Cancel appointment | unity_cancel_appointment |
| Save (create) patient | unity_save_patient |
| Update demographics | unity_update_demographics |

---

## One full conversation example

1. **AI:** "Hello, this is your healthcare assistant. I can help with appointments, medications, conditions, allergies, and diagnoses. How can I help?"
2. **User:** "I want my details."
3. **AI:** "I’ll need your first and last name and date of birth, or your medical record number."
4. **User:** "MRN is 29700."
5. **AI:** *(Calls unity_get_patient_by_mrn with mrn "29700", then says)* "I found you — Nichole Albanese, DOB April 24, 1928. Address 2748 Puckett St, Raleigh NC 27511. Phone (919) 555-1874. What would you like next?"
6. **User:** "What medications am I on?"
7. **AI:** *(Calls unity_get_patient_medications with patientId "764", then reads the list or says none.)*
8. **User:** "When are my appointments?"
9. **AI:** *(Calls unity_get_patient_appointments with patientId "764", then reads dates/times or says none.)*

Use this script to drive Test Chat / Test Audio in Retell with the reference patient above.
