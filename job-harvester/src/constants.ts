export const HARVEST_KNOWLEDGE_ID = "harvest-knowledge";
export const COMPANY_BLACKLIST_ID = "company-blacklist";
export const COMPANY_WHITELIST_ID = "company-whitelist";
export const HARVEST_PROMPT_CONFIG_ID = "harvest-prompt-config";

/** Max visits per domain per 24 hours */
export const VISIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_HARVEST_PROMPT = `Read the harvestKnowledge object in this space for current rules and user feedback. Also read the company blacklist (id: company-blacklist) and whitelist (id: company-whitelist). Do NOT harvest from any company on the blacklist. Always harvest from whitelisted companies. ALWAYS search for and discover NEW companies to add to the pool—the goal is an ever-expanding pool until we approach a fixpoint (likely thousands of companies). Visit their careers or jobs pages. Harvest qualifying jobs. Create Company and Job objects and link each job to its company via "belongsTo".`;

export const INITIAL_FILTER_RULES = `## STRICT JOB REQUIREMENTS (all must pass)

1. **Role type**: Must be a software engineer/developer role. Exclude: managers, directors, VPs, recruiters, designers, analysts, coordinators, scrum masters, product owners, technical writers.

2. **Seniority or AI**: The role must be EITHER:
   - Senior level: Senior, Staff, Principal, or Lead
   - OR AI/ML: AI Engineer, ML Engineer, Machine Learning Engineer, etc.

3. **Fully remote**: The role must be 100% remote. REJECT: hybrid, on-site, or any role requiring office attendance.

4. **No geo restrictions**: REJECT if the job has:
   - Country restrictions (e.g. "US only", "UK only", "EU only")
   - Citizenship requirements
   - Visa restrictions or "no visa sponsorship"
   - "Right to work in [country]" requirements
   - "Must be based in [country/region]"
   - "Open to candidates in [specific region]"
   Check both labels AND the full job description text.

5. **No Americas/EMEA timezone restrictions**: REJECT if the job requires:
   - Overlap with Americas timezone (EST, PST, US hours)
   - Overlap with EMEA timezone (CET, GMT, European hours)
   - "Must overlap with [Americas/EMEA/US/UK/Europe]"
   - "Working hours in [timezone]"`;
