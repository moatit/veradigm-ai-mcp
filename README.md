# Veradigm FHIR MCP 2.0 Server

A Model Context Protocol (MCP) 2.0 Server that provides read-only access to Veradigm FHIR API resources for AI voice agent integration.

## Overview

This MCP server exposes 20+ FHIR read-only operations as tools for AI voice agents, enabling:

- **Patient Verification**: Search and verify patient identity
- **Appointment Management**: Query appointments and schedules
- **Medication Information**: Access medication requests and refill status
- **Provider Directory**: Search healthcare providers and locations
- **Clinical Data**: Retrieve conditions, allergies, observations, and procedures

## Features

- 🔐 **OAuth 2.0 Authentication**: Client credentials flow with token caching
- 🏥 **FHIR R4 Compliance**: Full support for FHIR Release 4 standard
- 🚀 **High Performance**: Optimized for AI voice agent response times
- 🐳 **Containerized**: Docker support with multi-stage builds
- 📊 **Comprehensive Logging**: Detailed error handling and audit trails
- 🔄 **Environment Support**: Sandbox and production configurations

## Quick Start

### Prerequisites

- Node.js 18+
- Docker (optional)
- Veradigm Developer Account with FHIR API access

### 1. Clone and Install

```bash
git clone https://github.com/moatit/veradigm-ai-mcp.git
cd veradigm-ai-mcp
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your Veradigm credentials
```

### 3. Run Locally

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

### 4. Run with Docker

```bash
# Build and run
docker-compose up --build

# Or build manually
docker build -t veradigm-fhir-mcp-server .
docker run -p 3000:3000 veradigm-fhir-mcp-server
```

## Configuration

### Environment Variables

| Variable                   | Description                      | Default           |
| -------------------------- | -------------------------------- | ----------------- |
| `NODE_ENV`                 | Environment (sandbox/production) | `sandbox`         |
| `CLIENT_ID`                | OAuth 2.0 Client ID              | Required          |
| `CLIENT_SECRET`            | OAuth 2.0 Client Secret          | Required          |
| `FHIR_BASE_URL_SANDBOX`    | Sandbox FHIR endpoint            | Veradigm sandbox  |
| `FHIR_BASE_URL_PRODUCTION` | Production FHIR endpoint         | Required for prod |
| `TOKEN_CACHE_TTL`          | Token cache TTL (seconds)        | `3600`            |
| `CACHE_ENABLED`            | Enable token caching             | `true`            |

### Veradigm Setup

1. **Register Application**: Sign up at [Veradigm Developer Portal](https://developer.veradigm.com/)
2. **Get Credentials**: Obtain Client ID and Secret
3. **Configure Scopes**: Ensure `system/*.read` scope is granted
4. **Test Access**: Use provided Postman collection for testing

## Available Tools

### Patient Operations

- `search_patient` - Search patients by name, DOB, phone, MRN
- `get_patient_details` - Get detailed patient information
- `verify_patient_identity` - Verify patient identity with match scoring

### Appointment Operations

- `get_upcoming_appointments` - Get patient appointments
- `get_appointment_details` - Get specific appointment info
- `check_appointment_status` - Check appointment status
- `find_patient_next_appointment` - Find next scheduled appointment
- `get_appointments_by_date_range` - Get appointments in date range

### Medication Operations

- `get_patient_medications` - Get active patient medications
- `get_medication_requests` - Get medication requests
- `check_refill_status` - Check refill eligibility (read-only)
- `get_medication_statements` - Get medication history

### Provider Operations

- `search_providers` - Search healthcare providers
- `get_provider_details` - Get provider information
- `search_locations` - Search healthcare facilities
- `get_location_details` - Get location information

### Clinical Operations

- `get_patient_conditions` - Get patient conditions/diagnoses
- `get_allergies` - Get patient allergies
- `get_recent_observations` - Get vitals, lab results
- `get_patient_procedures` - Get patient procedures
- `get_patient_coverage` - Get insurance coverage

## Integration with AI Voice Agents

### RetellAI Integration

```javascript
// Example tool call
const result = await mcpClient.callTool({
  name: "verify_patient_identity",
  arguments: {
    firstName: "John",
    lastName: "Doe",
    birthDate: "1990-01-01",
    phone: "555-123-4567",
  },
});
```

### Voice Agent Use Cases

1. **Call Answering**: Verify caller identity and route appropriately
2. **Appointment Confirmation**: Check and confirm upcoming appointments
3. **Medication Inquiries**: Provide medication information and refill status
4. **Provider Lookup**: Find and provide provider contact information
5. **Clinical Context**: Access patient conditions for better assistance

## API Documentation

See the `docs/` directory for comprehensive documentation:

### HTML Documentation (Recommended)

Open `docs/index.html` in your browser for interactive documentation with diagrams:

- [Documentation Home](docs/index.html) - Main documentation hub
- [System Architecture](docs/architecture.html) - Architecture diagrams and data flow
- [Backend Documentation](docs/backend.html) - Services, tools, and utilities
- [API Reference](docs/api.html) - Complete API documentation
- [MCP Tools Reference](docs/tools.html) - All 21 MCP tools with parameters
- [Deployment Guide](docs/deployment.html) - Docker and cloud deployment
- [Integration Guide](docs/integration.html) - RetellAI integration

### Markdown Documentation

- [API Reference](docs/API.md) - Complete tool documentation
- [Integration Guide](docs/INTEGRATION.md) - RetellAI integration steps
- [FHIR Resources](docs/FHIR_RESOURCES.md) - Supported FHIR resources
- [Use Cases](docs/USE_CASES.md) - Voice agent scenarios
- [Postman Setup](docs/POSTMAN_SETUP.md) - Testing with Postman

## Testing

### Postman Collection

Import the provided Postman collection for comprehensive API testing:

```bash
# Import collection
postman/Veradigm_FHIR_Collection.json

# Import environments
postman/environments/Sandbox.json
postman/environments/Production.json
```

### MCP Inspector

Test the MCP server locally:

```bash
# Install MCP Inspector
npm install -g @modelcontextprotocol/inspector

# Run inspector
mcp-inspector
```

## Development

### Project Structure

```
src/
├── index.ts                 # MCP server entry point
├── config/
│   ├── environment.ts      # Environment configuration
│   └── fhir-endpoints.ts   # FHIR endpoint definitions
├── services/
│   ├── auth.service.ts     # OAuth 2.0 authentication
│   ├── fhir.service.ts     # FHIR API client
│   └── cache.service.ts    # Token caching
├── tools/
│   ├── patient.tools.ts    # Patient operations
│   ├── appointment.tools.ts # Appointment operations
│   ├── medication.tools.ts # Medication operations
│   ├── provider.tools.ts   # Provider operations
│   └── clinical.tools.ts   # Clinical operations
└── utils/
    ├── fhir-parser.ts      # FHIR response parsing
    └── error-handler.ts    # Error handling
```

### Scripts

```bash
npm run build      # Build TypeScript
npm run start      # Start production server
npm run dev        # Start development server
npm run test       # Run tests
npm run lint       # Run ESLint
```

## Phase 2 Roadmap

Future enhancements for write operations:

- Appointment scheduling/rescheduling
- Prescription refill request submission
- Patient communication preferences
- Consent management
- Advanced authentication (SMART on FHIR)

## Security & Compliance

- **HIPAA Compliance**: Read-only access with audit logging
- **OAuth 2.0**: Secure authentication with token caching
- **Rate Limiting**: Built-in request throttling
- **Error Handling**: Comprehensive error management
- **Logging**: Detailed audit trails for compliance

## Support

- **Documentation**: See `docs/` directory
- **Issues**: Report via GitHub issues
- **Veradigm Support**: [Developer Portal](https://developer.veradigm.com/)

## License

MIT License - see LICENSE file for details.
