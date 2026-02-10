import dotenv from "dotenv";

dotenv.config();

export interface UnityEnvironmentConfig {
  nodeEnv: "sandbox" | "production";

  // Unity Application Configuration
  appName: string;

  // Unity Service Credentials (for GetToken)
  svcUsername: string;
  svcPassword: string;

  // EHR/PM User Credentials (for GetUserAuthentication)
  ehrUsername: string;
  ehrPassword: string;

  // Unity Endpoints
  ubiquityEndpoint: string;
  ubiquityIdPM: string;
  ubiquityIdEHR: string;

  // Token Configuration
  tokenCacheTtl: number;
  tokenRefreshBuffer: number; // Refresh token this many seconds before expiry

  // Server Configuration
  mcpServerPort: number;
  mcpServerHost: string;

  // Logging
  logLevel: string;
}

function getUnityEnvironmentConfig(): UnityEnvironmentConfig {
  const nodeEnv =
    (process.env.NODE_ENV as "sandbox" | "production") || "sandbox";

  // Validate required environment variables
  const requiredVars = [
    "UNITY_APP_NAME",
    "UNITY_SVC_USERNAME",
    "UNITY_SVC_PASSWORD",
    "UNITY_EHR_USERNAME",
    "UNITY_EHR_PASSWORD",
  ];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      throw new Error(
        `${varName} environment variable is required for Unity API`
      );
    }
  }

  return {
    nodeEnv,

    // Unity Application Configuration
    appName: process.env.UNITY_APP_NAME!,

    // Unity Service Credentials
    svcUsername: process.env.UNITY_SVC_USERNAME!,
    svcPassword: process.env.UNITY_SVC_PASSWORD!,

    // EHR/PM User Credentials
    ehrUsername: process.env.UNITY_EHR_USERNAME!,
    ehrPassword: process.env.UNITY_EHR_PASSWORD!,

    // Unity Endpoints - Default to sandbox Ubiquity endpoint
    ubiquityEndpoint:
      process.env.UNITY_UBIQUITY_ENDPOINT ||
      "https://ubiquityunity.azurewebsites.net/UnityService.svc",
    ubiquityIdPM: process.env.UNITY_UBIQUITY_ID_PM || "VHCP001PM:PMGA02^8^",
    ubiquityIdEHR: process.env.UNITY_UBIQUITY_ID_EHR || "AHMCP00101:CP00101^1^",

    // Token Configuration
    // Unity tokens expire after 20 minutes of inactivity
    tokenCacheTtl: parseInt(process.env.UNITY_TOKEN_CACHE_TTL || "1140"), // 19 minutes
    tokenRefreshBuffer: parseInt(
      process.env.UNITY_TOKEN_REFRESH_BUFFER || "60"
    ), // 1 minute before expiry

    // Server Configuration
    mcpServerPort: parseInt(process.env.UNITY_MCP_SERVER_PORT || "3001"),
    mcpServerHost: process.env.UNITY_MCP_SERVER_HOST || "localhost",

    // Logging
    logLevel: process.env.LOG_LEVEL || "info",
  };
}

export const unityConfig = getUnityEnvironmentConfig();
