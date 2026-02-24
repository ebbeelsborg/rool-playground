# Rool Job Harvester & Job Matcher

LLM-powered apps for harvesting remote software engineer jobs and matching them to your resume. Built on the [Rool SDK](https://docs.rool.dev/) with Gemini via Rool's token quota.

## Apps

### 1. Job Harvester

Crawls **company careers pages** (not job portals) for remote software engineer jobs. Features:

- **Inbox / Saved / Discarded** buckets with vertical dot menu on each job card
- **Save** (star) or **Discard with reason** – feedback improves future harvests
- **Dynamic filtering** – rules live in a Rool `harvestKnowledge` object and evolve from user feedback
- **Company whitelist/blacklist** – mark companies to only harvest from (whitelist) or never harvest from (blacklist)
- **Versioned harvest prompt** – view, edit, and version the prompt the AI uses; restore previous versions

### 2. Job Matcher (companion app)

Consumes harvester data. Upload your resume (PDF), then:

- **Match score** – LLM rates each job 0–100% vs your resume
- **Keywords** – 10–25 keywords per job (technical + soft skills) with priority (high/medium/low)

## Setup

```bash
cd job-harvester && npm install
cd ../job-matcher && npm install
```

## Run

### Job Harvester

```bash
npm run harvester:dev
```

Open http://localhost:5173. Sign in to Rool, then click **Run Harvest**.

### Job Matcher

```bash
npm run matcher:dev
```

Open http://localhost:5173. Upload a PDF resume, then click **Match All Jobs**.

### CLI harvest (one-off)

```bash
npm run harvester:harvest
```

### Continuous harvest (runs forever)

```bash
npm run harvester:continuous
```

Runs every 10 minutes. Each website is visited at most once per 24 hours (tracked in `visitedDomains` on the harvest knowledge object).

## Data Model

**Harvester:**

- **Company**: `type="company"`, `name`, `careersUrl`, `websiteUrl`
- **Job**: `type="job"`, `title`, `description`, `url`, `level`, `companyName`, `status` (inbox|saved|discarded), `discardReason`
- **harvestKnowledge**: `type="harvestKnowledge"`, `rules`, `feedbackLog`, `visitedDomains` – grows from discard feedback
- **companyBlacklist**: `type="companyBlacklist"`, `companies` (string[]) – never harvest from these
- **companyWhitelist**: `type="companyWhitelist"`, `companies` (string[]) – always harvest from these; LLM also discovers new companies to expand the pool
- **harvestPromptConfig**: `type="harvestPromptConfig"`, `currentText`, `currentVersion`, `versionHistory` – versioned prompt

**Matcher:**

- **resume**: `type="resume"`, `text` – extracted from uploaded PDF
- **keyword**: `type="keyword"`, `text`, `priority` (high|medium|low) – linked to job via `hasKeyword`
- Jobs get `matchScore` (0–100) after matching

## Publish

```bash
npm run harvester:build
npx @rool-dev/cli app publish job-harvester ./job-harvester/dist -n "Job Harvester"

npm run matcher:build
npx @rool-dev/cli app publish job-matcher ./job-matcher/dist -n "Job Matcher"
```
