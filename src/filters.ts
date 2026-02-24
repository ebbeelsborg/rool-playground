/**
 * Job filtering logic inspired by remote-job-aggregator.
 * Used to validate jobs meet the strict criteria:
 * - Software engineer/developer role
 * - Senior (Senior/Staff/Principal/Lead) or AI/ML role
 * - Fully remote (no hybrid/on-site)
 * - No country/citizenship/visa restrictions
 * - No Americas or EMEA timezone restrictions
 */

const EXCLUDED_ROLES = [
  /\bmanager\b/i,
  /\bdirector\b/i,
  /\bvice\s+president\b/i,
  /\b(?:vp)\b/i,
  /\bhead\s+of\b/i,
  /\bchief\b/i,
  /\brecruiter\b/i,
  /\bdesigner\b/i,
  /\banalyst\b/i,
  /\bcoordinator\b/i,
  /\bscrum\s+master\b/i,
  /\bproject\s+manager\b/i,
  /\bproduct\s+owner\b/i,
  /\btechnical\s+writer\b/i,
];

const SOFTWARE_TITLES = [
  "software engineer",
  "software developer",
  "developer",
  "engineer",
  "swe",
  "backend engineer",
  "frontend engineer",
  "full-stack",
  "fullstack",
  "devops",
  "sre",
  "platform engineer",
  "ml engineer",
  "machine learning engineer",
  "ai engineer",
  "research engineer",
];

const ACCEPTABLE_LEVELS = ["senior", "staff", "principal", "lead", "ai", "ai/ml", "ai / ml", "machine learning"];

export function isSoftwareEngineerRole(title: string): boolean {
  const t = title.toLowerCase().trim();
  if (EXCLUDED_ROLES.some((p) => p.test(t))) return false;
  return SOFTWARE_TITLES.some((w) => {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return re.test(t);
  });
}

export function isSeniorOrAIRole(title: string, level?: string | null): boolean {
  const text = `${title} ${level || ""}`.toLowerCase();
  return ACCEPTABLE_LEVELS.some((l) => text.includes(l));
}

export function descriptionIndicatesGeoRestriction(description?: string | null, title?: string | null): boolean {
  if (!description || description.trim().length < 10) return false;
  const text = `${title || ""} ${description}`.toLowerCase();

  const explicitRestrictionPatterns = [
    /\bremote\s*[\(\[\-–—]\s*(?:us|usa|uk|eu|canada|india|germany|france|australia|brazil|emea|latam|americas?|europe)\s*(?:only|required|residents?)\s*[\)\]]/i,
    /\b(?:us|usa|uk|canada|india|eu)\s*(?:only|based|residents?|citizens?)\b/i,
    /\bopen\s+(?:only\s+)?to\s+(?:candidates|applicants|individuals|residents)\s+(?:in|from|based in)\b/i,
    /\brestricted\s+to\s+(?:candidates|applicants|residents|individuals)\s+(?:in|from|of)\b/i,
    /\bcandidate\s+must\s+be\s+located\s+in\b/i,
    /\bmust\s+be\s+based\s+in\b/i,
    /\b100%\s*remote\s+(?:in|within)\b/i,
    /\bhome-based\s+in\b/i,
    /\bopportunity\s+based\s+in\b/i,
  ];

  for (const pattern of explicitRestrictionPatterns) {
    if (pattern.test(text)) return true;
  }

  const legalRequirements = [
    /\bright\s+to\s+work\s+in\s+(?:the\s+)?(?:us|usa|uk|eu|canada|australia)/i,
    /\beligib(?:le|ility)\s+to\s+work\s+in\s+(?:the\s+)?/i,
    /\bwork\s+authori[sz]ation\s+(?:in|for)\s+(?:the\s+)?/i,
    /\blegal(?:ly)?\s+authori[sz](?:ed|ation)\s+(?:to\s+)?work\s+in\b/i,
    /\bpermanent\s+residen(?:t|ce|cy)\s+(?:in|of)\s+(?:the\s+)?/i,
    /\bcitizen(?:ship)?\s+(?:required|only)\b/i,
    /\b(?:us|usa|u\.s\.?)\s+citizen\b/i,
    /\bcitizen\s*\/\s*visa\s+only\b/i,
    /\bvisa\s+sponsor(?:ship)?\s+(?:is\s+)?not\s+(?:available|offered|provided)\b/i,
    /\bno\s+visa\s+sponsor(?:ship)?\b/i,
    /\bvisa\s+(?:required|only)\b/i,
  ];

  for (const pattern of legalRequirements) {
    if (pattern.test(text)) return true;
  }

  const hybridPatterns = [
    /\bhybrid\b/i,
    /\bin[- ]?office\s+\d+\s*(?:days?|times?)\s+(?:a|per)\s+week\b/i,
    /\bon[- ]?site\s+\d+\s*(?:days?|times?)\s+(?:a|per)\s+week\b/i,
    /\b\d+\s*(?:days?|times?)\s+(?:a|per)\s+week\s+(?:in[- ]?office|on[- ]?site|in\s+person)\b/i,
    /\bremote(?:ly)?\s+but\b.*?\b(?:report|office|on[- ]?site|in[- ]?person)\b/i,
  ];

  for (const pattern of hybridPatterns) {
    if (pattern.test(text)) return true;
  }

  return false;
}

/**
 * Detects timezone restrictions for Americas or EMEA specifically.
 * Discard jobs that require overlap with Americas or EMEA timezones.
 */
export function hasAmericasOrEMEATimezoneRestriction(
  description?: string | null,
  title?: string | null
): boolean {
  if (!description || description.trim().length < 10) return false;
  const text = `${title || ""} ${description}`.toLowerCase();

  const americasEmeaPatterns = [
    /\b(?:americas?|north\s+america|latam|us\s+timezone|est|pst|mst|cst|eastern|pacific|central)\s+(?:timezone|hours?|overlap|based)\b/i,
    /\b(?:emea|europe|european|uk\s+timezone|cet|gmt|bst)\s+(?:timezone|hours?|overlap|based)\b/i,
    /\boverlap\s+with\s+(?:utc|gmt|est|pst|cet|cst|european|americas?|emea)\b/i,
    /\bbased\s+within\s+(?:[\+\-]\s*\d+\s*hours?|timezone)\b/i,
    /\bworking\s+hours?\s+are\s+in\b/i,
    /\b(?:must|need to|required to)\s+overlap\s+with\s+(?:americas?|emea|europe|us|uk)\b/i,
  ];

  for (const pattern of americasEmeaPatterns) {
    if (pattern.test(text)) return true;
  }
  return false;
}

export function isFullyRemote(locationLabels?: string | string[] | null, description?: string | null): boolean {
  const remoteIndicators = [
    "remote",
    "anywhere",
    "worldwide",
    "global",
    "work from home",
    "wfh",
    "distributed",
  ];
  const hybridReject = /\bhybrid\b|\bin[- ]?office\b|\bon[- ]?site\b/i;

  if (description && hybridReject.test(description)) return false;

  if (Array.isArray(locationLabels)) {
    const joined = locationLabels.join(" ").toLowerCase();
    if (hybridReject.test(joined)) return false;
    return remoteIndicators.some((r) => joined.includes(r));
  }
  if (typeof locationLabels === "string") {
    const lower = locationLabels.toLowerCase();
    if (hybridReject.test(lower)) return false;
    return remoteIndicators.some((r) => lower.includes(r));
  }
  return false;
}

export interface JobCandidate {
  title: string;
  description?: string | null;
  level?: string | null;
  location?: string | string[] | null;
  url?: string | null;
  company?: string | null;
}

/**
 * Returns true if the job passes all filter requirements.
 */
export function passesJobFilter(job: JobCandidate): boolean {
  if (!isSoftwareEngineerRole(job.title)) return false;
  if (!isSeniorOrAIRole(job.title, job.level)) return false;
  if (!isFullyRemote(job.location, job.description)) return false;
  if (descriptionIndicatesGeoRestriction(job.description, job.title)) return false;
  if (hasAmericasOrEMEATimezoneRestriction(job.description, job.title)) return false;
  return true;
}
