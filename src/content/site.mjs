// Single source of truth for site-wide facts, contact details and claims.
// Every number on the site comes from here (see docs/CLAIMS_REGISTER.md for sources).

export const SITE = {
  url: "https://drawbridge.moatit.com", // canonical origin (Ali's decision, Oct 16 2026)
  name: "Drawbridge",
  tagline: "MOATiT's AI technology for healthcare practices",
  endorsement: "A MOATiT Service",
  locale: "en_US",
  // Placeholder endpoint for the demo form. Replace before launch (see docs/DEPLOYMENT.md).
  demoEndpoint: "/api/demo-request",
  ogImage: "/assets/img/og-drawbridge.png",
  lastUpdated: "2026-10-18",
};

export const ORG = {
  legalName: "MOATiT, LLC",
  brand: "MOATiT",
  url: "https://www.moatit.com",
  email: "questions@moatit.com",
  phones: [
    { label: "(208) 900-6628", tel: "+12089006628", note: "Idaho" },
    { label: "(855) 550-6628", tel: "+18555506628", note: "Toll-free" },
  ],
  address: {
    street: "2306 Pocatello Creek Rd",
    city: "Pocatello",
    region: "ID",
    postal: "83201",
    country: "US",
  },
  founded: "2013",
};

export const TRADEMARK_NOTE =
  "Veradigm® is a registered trademark of Veradigm Inc. or its affiliates. Drawbridge is a product of MOATiT, LLC. References to Veradigm® products describe compatibility only and do not imply endorsement by Veradigm.";

export const COMPAT_LINE = "Integrates with Veradigm® EHR and Veradigm® Practice Management";

// Proof points. Synthetic-test numbers are labeled as such everywhere they appear.
export const CLAIMS = {
  wrongPatient: {
    label: "Synthetic test",
    num: "0",
    what: "wrong-patient filings in our accuracy testing",
    how: "Held-out synthetic test sets of 3,000 documents each (4,402 result pages in the latest run), Oct 11–13, 2026. Invented patients and document layouts; no real patient data.",
  },
  liveSandbox: {
    label: "Sandbox test",
    num: "20 of 20",
    what: "auto-filed documents landed in the right patient's chart",
    how: "Live run on an EHR vendor's test system with synthetic patients, Oct 11, 2026: 55 synthetic faxes, including multi-patient lab batches. Everything uncertain went to staff, by design.",
  },
  autoFile: {
    label: "Synthetic test",
    num: "~50%",
    what: "of documents filed with no staff touch; the rest arrive pre-read for one-click review",
    how: "Held-out synthetic set of 3,000 documents, name + DOB rule, Oct 13, 2026. Real faxes vary with quality; your shadow week measures your own rate.",
  },
  latency: {
    label: "Unreleased agent version, web calls",
    num: "1.4 s",
    what: "median time to first response when the assistant looks something up",
    how: "13 lookup turns across pre-release test calls with synthetic patients, Oct 15, 2026 (median 1.36 s). Small sample; re-measured on the phone network before go-live.",
  },
};

export const NAV = [
  { href: "/fax-lab-intake/", label: "Fax & Labs" },
  { href: "/phone-assistant/", label: "Phone Assistant" },
  { href: "/call-and-confirm/", label: "Call & Confirm" },
  { href: "/platform/", label: "Staff Tools" },
  { href: "/security/", label: "Security" },
  { href: "/integrations/", label: "Integrations" },
  { href: "/pricing/", label: "Pricing" },
  { href: "/about/", label: "About" },
];

// Public test line for the phone assistant: Veradigm sandbox, synthetic records only (veradigm-ai-mcp docs/handover/05_TEST_DATA.md).
export const TEST_LINE = {
  label: "(208) 904-3641",
  tel: "+12089043641",
  patients: [
    { name: "Ed Smith", dob: "December 6, 1952" },
    { name: "Nichole Albanese", dob: "April 24, 1928" },
  ],
};

export const CTA = {
  primary: { href: "/contact/", label: "Book a 20-minute walkthrough" },
  call: { href: "/phone-assistant/#sample-call", label: "See a sample call" },
  live: { label: "Test a live call now" },
  fax: { href: "/fax-lab-intake/#sample-filing", label: "See a fax get filed" },
  roi: { href: "/roi/", label: "Calculate your time savings" },
  security: { href: "/security/", label: "Read our security overview" },
};
