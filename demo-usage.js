#!/usr/bin/env node

/**
 * Veradigm FHIR MCP Server - Demo Usage Script
 * यह script दिखाता है कि server का इस्तेमाल कैसे करें
 */

const axios = require("axios");

const BASE_URL = "http://localhost:3000";

// Colors for terminal output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function demo() {
  log("\n🎬 Veradigm FHIR MCP Server - Live Demo\n", "cyan");

  try {
    // 1. Health Check
    log("📊 Step 1: Health Check", "blue");
    const health = await axios.get(`${BASE_URL}/health`);
    log(`✅ Server Status: ${health.data.status}`, "green");
    log(`   Environment: ${health.data.environment}`, "green");
    log(`   FHIR URL: ${health.data.fhirBaseUrl}\n`, "green");

    // 2. Authentication Test
    log("🔐 Step 2: Authentication Test", "blue");
    const auth = await axios.get(`${BASE_URL}/test/auth`);
    if (auth.data.success) {
      log(`✅ Authentication: SUCCESS`, "green");
      log(`   Token Length: ${auth.data.tokenLength} characters\n`, "green");
    } else {
      log(`❌ Authentication Failed: ${auth.data.error}`, "red");
      return;
    }

    // 3. List Available Tools
    log("🛠️  Step 3: Available Tools", "blue");
    const tools = await axios.get(`${BASE_URL}/tools`);
    log(`✅ Total Tools: ${tools.data.tools.length}`, "green");
    tools.data.tools.forEach((tool, index) => {
      log(`   ${index + 1}. ${tool.name}`, "yellow");
    });
    log("");

    // 4. Search Patient (Example)
    log("🔍 Step 4: Patient Search Demo", "blue");
    log('   Searching for patient with name "Smith"...', "yellow");

    try {
      const patientSearch = await axios.post(
        `${BASE_URL}/test/search-patient`,
        {
          name: "Smith",
          birthDate: "1990-01-01",
        }
      );

      if (patientSearch.data.total > 0) {
        log(`✅ Found ${patientSearch.data.total} patients`, "green");
        log(`   Patient data:`, "green");
        console.log(JSON.stringify(patientSearch.data.patients[0], null, 2));
      } else {
        log(
          `ℹ️  No patients found (This is normal in sandbox without test data)`,
          "yellow"
        );
      }
    } catch (error) {
      if (error.response) {
        log(
          `⚠️  Patient search response: ${JSON.stringify(
            error.response.data,
            null,
            2
          )}`,
          "yellow"
        );
      } else {
        throw error;
      }
    }

    log("\n" + "=".repeat(60), "cyan");
    log("✨ Demo Complete! Server is working properly!", "green");
    log("=".repeat(60) + "\n", "cyan");

    // Usage Instructions
    log("📚 अगले Steps (Next Steps):", "blue");
    log("");
    log("1. Claude Desktop में integrate करें:", "yellow");
    log(
      "   ~/Library/Application Support/Claude/claude_desktop_config.json में config add करें\n",
      "reset"
    );

    log("2. HTTP API का इस्तेमाल करें:", "yellow");
    log(
      "   curl -X POST http://localhost:3000/test/search-patient \\",
      "reset"
    );
    log('     -H "Content-Type: application/json" \\', "reset");
    log('     -d \'{"name": "Smith"}\'\n', "reset");

    log("3. अपने Voice Agent से integrate करें:", "yellow");
    log("   RetellAI, Twilio, या custom solution\n", "reset");

    log("📖 विस्तृत गाइड के लिए देखें:", "blue");
    log("   - USAGE_GUIDE_HINDI.md", "cyan");
    log("   - SETUP_SUMMARY.md", "cyan");
    log("   - docs/ folder\n", "cyan");
  } catch (error) {
    log("\n❌ Error occurred:", "red");
    if (error.code === "ECONNREFUSED") {
      log("   Server is not running!", "red");
      log("   Please start the server first:", "yellow");
      log("   npx ts-node src/test-server.ts\n", "cyan");
    } else {
      log(`   ${error.message}\n`, "red");
      if (error.response) {
        console.log(error.response.data);
      }
    }
  }
}

// Run demo
log("\n" + "=".repeat(60), "cyan");
log("  Veradigm FHIR MCP Server - Usage Demo  ", "cyan");
log("=".repeat(60) + "\n", "cyan");

demo().catch((error) => {
  log("\nFatal error:", "red");
  console.error(error);
  process.exit(1);
});
