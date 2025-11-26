# Postman Setup Guide

## Overview

This guide provides step-by-step instructions for setting up and using the Veradigm FHIR MCP Server Postman collection for testing and development.

## Prerequisites

- Postman application installed
- Veradigm Developer Account with FHIR API access
- Valid OAuth 2.0 credentials (Client ID and Secret)

## Setup Instructions

### 1. Import Collection and Environment

#### Import Collection
1. Open Postman
2. Click **Import** button
3. Select **File** tab
4. Navigate to `postman/Veradigm_FHIR_Collection.json`
5. Click **Import**

#### Import Environment
1. Click **Import** button again
2. Select **File** tab
3. Navigate to `postman/environments/Sandbox.json`
4. Click **Import**
5. Repeat for `postman/environments/Production.json` if needed

### 2. Configure Environment Variables

#### Sandbox Environment
1. Click the environment dropdown (top right)
2. Select **Veradigm FHIR Sandbox**
3. Click the **eye icon** to view variables
4. Update the following variables:

| Variable | Value | Description |
|----------|-------|-------------|
| `CLIENT_ID` | Your sandbox client ID | OAuth 2.0 Client ID |
| `CLIENT_SECRET` | Your sandbox client secret | OAuth 2.0 Client Secret |
| `patient_name` | Test patient name | For testing patient searches |
| `patient_birthdate` | Test birth date (YYYY-MM-DD) | For testing patient searches |
| `practitioner_name` | Test practitioner name | For testing provider searches |
| `location_name` | Test location name | For testing location searches |

#### Production Environment
1. Select **Veradigm FHIR Production** environment
2. Update the following variables:

| Variable | Value | Description |
|----------|-------|-------------|
| `FHIR_BASE_URL` | Your production FHIR URL | Production FHIR endpoint |
| `TOKEN_URL` | Your production token URL | Production OAuth token endpoint |
| `AUTH_URL` | Your production auth URL | Production OAuth auth endpoint |
| `CLIENT_ID` | Your production client ID | Production OAuth Client ID |
| `CLIENT_SECRET` | Your production client secret | Production OAuth Client Secret |

### 3. Authentication Setup

#### Automatic Token Management
The collection includes automatic token management:

1. **Pre-request Script**: Automatically refreshes tokens when expired
2. **Token Storage**: Stores access tokens in environment variables
3. **Token Expiry**: Tracks token expiration times

#### Manual Token Request
If you need to manually request a token:

1. Navigate to **Authentication** → **Get Access Token**
2. Click **Send**
3. Check the **Tests** tab for token validation
4. Token will be automatically stored in environment variables

### 4. Testing API Endpoints

#### Patient Operations

**Search Patients by Name**
1. Navigate to **Patient Operations** → **Search Patients by Name**
2. Ensure `patient_name` variable is set
3. Click **Send**
4. Check response for patient data

**Get Patient by ID**
1. First run a patient search to get a patient ID
2. Navigate to **Patient Operations** → **Get Patient by ID**
3. The `patient_id` variable should be automatically set
4. Click **Send**

#### Appointment Operations

**Get Patient Appointments**
1. Ensure you have a valid `patient_id`
2. Navigate to **Appointment Operations** → **Get Patient Appointments**
3. Click **Send**
4. Check response for appointment data

**Get Appointment by ID**
1. First run a patient appointments request to get an appointment ID
2. Navigate to **Appointment Operations** → **Get Appointment by ID**
3. The `appointment_id` variable should be automatically set
4. Click **Send**

#### Medication Operations

**Get Patient Medications**
1. Ensure you have a valid `patient_id`
2. Navigate to **Medication Operations** → **Get Patient Medications**
3. Click **Send**
4. Check response for medication data

#### Provider Operations

**Search Practitioners**
1. Set the `practitioner_name` variable
2. Navigate to **Provider Operations** → **Search Practitioners**
3. Click **Send**
4. Check response for practitioner data

#### Clinical Operations

**Get Patient Conditions**
1. Ensure you have a valid `patient_id`
2. Navigate to **Clinical Operations** → **Get Patient Conditions**
3. Click **Send**
4. Check response for condition data

### 5. Running Test Sequences

#### Complete Patient Workflow
1. **Get Access Token** → Verify authentication
2. **Search Patients by Name** → Find test patient
3. **Get Patient by ID** → Get patient details
4. **Get Patient Appointments** → Check appointments
5. **Get Patient Medications** → Check medications
6. **Get Patient Conditions** → Check conditions

#### Appointment Workflow
1. **Get Access Token** → Verify authentication
2. **Get Patient Appointments** → Find appointments
3. **Get Appointment by ID** → Get appointment details
4. **Get Appointments by Date Range** → Check date range

#### Provider Workflow
1. **Get Access Token** → Verify authentication
2. **Search Practitioners** → Find providers
3. **Search Locations** → Find facilities
4. **Get FHIR Capabilities** → Check system capabilities

### 6. Troubleshooting

#### Common Issues

**Authentication Errors**
- **401 Unauthorized**: Check CLIENT_ID and CLIENT_SECRET
- **403 Forbidden**: Verify scopes are granted
- **Token Expired**: Token will auto-refresh, check pre-request script

**Data Not Found**
- **404 Not Found**: Verify patient IDs exist in test data
- **Empty Results**: Check search parameters
- **Invalid Parameters**: Verify parameter formats

**Network Errors**
- **Connection Refused**: Check FHIR_BASE_URL
- **Timeout**: Check network connectivity
- **SSL Errors**: Verify certificate validity

#### Debug Steps

1. **Check Environment Variables**
   - Verify all required variables are set
   - Check for typos in variable names
   - Ensure values are properly formatted

2. **Check Request Headers**
   - Verify Authorization header is present
   - Check Accept header is set to `application/fhir+json`
   - Ensure Content-Type is correct

3. **Check Response**
   - Look for error messages in response body
   - Check HTTP status codes
   - Verify response format is JSON

4. **Check Console**
   - Look for JavaScript errors in pre-request scripts
   - Check for network errors
   - Verify token refresh logic

### 7. Advanced Configuration

#### Custom Search Parameters

You can modify requests to test different scenarios:

**Patient Search with Multiple Parameters**
```javascript
// Modify the URL to include multiple search parameters
{{FHIR_BASE_URL}}/Patient?name={{patient_name}}&birthdate={{patient_birthdate}}&gender=male
```

**Appointment Search with Date Range**
```javascript
// Set custom date range
{{FHIR_BASE_URL}}/Appointment?patient={{patient_id}}&date=ge2024-01-01&date=le2024-12-31
```

**Medication Search with Status**
```javascript
// Search for specific medication status
{{FHIR_BASE_URL}}/MedicationRequest?patient={{patient_id}}&status=active&intent=order
```

#### Custom Test Scripts

Add custom test scripts to validate responses:

```javascript
// Test for specific patient data
pm.test("Patient has required fields", function () {
    const jsonData = pm.response.json();
    pm.expect(jsonData).to.have.property('id');
    pm.expect(jsonData).to.have.property('name');
    pm.expect(jsonData).to.have.property('birthDate');
});

// Test for appointment data
pm.test("Appointment has required fields", function () {
    const jsonData = pm.response.json();
    pm.expect(jsonData).to.have.property('id');
    pm.expect(jsonData).to.have.property('status');
    pm.expect(jsonData).to.have.property('start');
    pm.expect(jsonData).to.have.property('end');
});
```

#### Environment-Specific Testing

**Sandbox Testing**
- Use test data provided by Veradigm
- Test with known patient IDs
- Verify all endpoints work correctly

**Production Testing**
- Use real patient data (with proper authorization)
- Test with actual appointment data
- Verify performance and reliability

### 8. Collection Features

#### Automatic Token Refresh
- Tokens are automatically refreshed when expired
- No manual intervention required
- Handles token storage and retrieval

#### Environment Variable Management
- Automatic variable extraction from responses
- Patient IDs and appointment IDs are stored automatically
- Easy switching between sandbox and production

#### Test Validation
- Automatic response validation
- Error detection and reporting
- Performance monitoring

#### Request Chaining
- Responses from one request can be used in subsequent requests
- Automatic variable extraction for related resources
- Seamless workflow testing

### 9. Best Practices

#### Security
- Never commit credentials to version control
- Use environment variables for sensitive data
- Regularly rotate API credentials

#### Testing
- Test with various data scenarios
- Verify error handling
- Test rate limiting and pagination

#### Documentation
- Document custom test scenarios
- Keep environment variables updated
- Maintain test data consistency

#### Performance
- Monitor response times
- Test with large datasets
- Verify pagination works correctly

### 10. Support and Resources

#### Veradigm Documentation
- [FHIR API Documentation](https://developer.veradigm.com/Fhir/Resources)
- [Authentication Guide](https://developer.veradigm.com/Fhir/ProcessOverview)
- [Endpoint Directory](https://developer.veradigm.com/Fhir/EndpointDirectory)

#### Postman Resources
- [Postman Learning Center](https://learning.postman.com/)
- [Postman API Documentation](https://documenter.postman.com/)
- [Postman Community](https://community.postman.com/)

#### Troubleshooting
- Check Veradigm support for API issues
- Use Postman console for debugging
- Review collection test results for validation errors

This Postman collection provides a comprehensive testing environment for the Veradigm FHIR MCP Server, enabling developers to validate all functionality before integration with voice agents.




