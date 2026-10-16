/**
 * Print the tool definitions the phone agent registers (Unity + platform + FHIR), as JSON, without
 * starting a server or calling Veradigm. Used by deploy/local/retell/build_v7.py to build the Retell
 * custom functions from the code's own (trimmed) descriptions and schemas.
 *
 *   npx ts-node src/scripts/dump-agent-tools.ts > tools.json
 */
for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD', 'CLIENT_ID', 'CLIENT_SECRET']) process.env[k] = process.env[k] || 'dump-tools';

async function main(): Promise<void> {
  const { UnityAuthService } = await import('../unity/services/unity-auth.service');
  const { UnityService } = await import('../unity/services/unity.service');
  const { UnityAppointmentTools } = await import('../unity/tools/appointment.tools');
  const { UnityPatientTools } = await import('../unity/tools/patient.tools');
  const { UnityClinicalTools } = await import('../unity/tools/clinical.tools');
  const { UnityBillingTools } = await import('../unity/tools/billing.tools');
  const { UnityTaskTools } = await import('../unity/tools/task.tools');
  const { loadPlatformModules } = await import('../platform/modules');
  const { platformTools } = await import('../platform/registry');
  const { FHIRService } = await import('../services/fhir.service');
  const { AuthService } = await import('../services/auth.service');
  const { PatientTools } = await import('../tools/patient.tools');
  const { MedicationTools } = await import('../tools/medication.tools');
  const { ClinicalTools } = await import('../tools/clinical.tools');

  const unity = new UnityService(new UnityAuthService());
  loadPlatformModules();
  const fhir = new FHIRService(new AuthService());
  const out = {
    unity: [
      ...new UnityAppointmentTools(unity).getTools(),
      ...new UnityPatientTools(unity).getTools(),
      ...new UnityClinicalTools(unity).getTools(),
      ...new UnityBillingTools(unity).getTools(),
      ...new UnityTaskTools(unity).getTools(),
      ...platformTools(),
    ],
    fhir: [...new PatientTools(fhir).getTools(), ...new MedicationTools(fhir).getTools(), ...new ClinicalTools(fhir).getTools()],
  };
  const { compactAgentTools } = await import('../platform/agent-tools');
  (out as any).retell = compactAgentTools(out as any);
  const file = process.argv[2];
  if (file) require('fs').writeFileSync(file, JSON.stringify(out, null, 1));
  else process.stdout.write(JSON.stringify(out, null, 1));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e?.message || e);
    process.exit(1);
  }
);
