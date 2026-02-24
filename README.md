# Rool Job Harvester

An LLM-powered app that crawls **company careers pages** (not job portals) for remote software engineer jobs. Built on the [Rool SDK](https://docs.rool.dev/) with Gemini via Rool's token quota.

## Requirements

- **Role**: Software engineer/developer (Senior, Staff, Principal, Lead, or AI/ML)
- **Location**: Fully remote (no hybrid or on-site)
- **Geo**: No country, citizenship, or visa restrictions
- **Timezone**: No Americas or EMEA timezone overlap requirements

## Setup

```bash
npm install
```

## Run

### Web app (React)

```bash
npm run dev
```

Open http://localhost:5173. Sign in to Rool, then click **Run Harvest** to trigger the AI.

### CLI (Node.js)

```bash
npm run harvest
```

On first run, a browser will open for Rool authentication. After signing in, the app will create/open the space and run the harvest.

## Publish to Rool

```bash
npm run build
npx @rool-dev/cli app publish job-harvester ./dist -n "Job Harvester"
```

Your app will be available at `https://use.rool.app/<your-slug>/job-harvester/`. Note: App publishing may require a Rool plan that supports it.

## Data Model

- **Company**: `type="company"`, `name`, `careersUrl`, `websiteUrl`
- **Job**: `type="job"`, `title`, `description`, `url`, `level`, `companyName`
- **Relation**: `Job --[belongsTo]--> Company`

## Filter Logic

The filtering logic in `src/filters.ts` is inspired by [remote-job-aggregator](https://github.com/ebbeelsborg/remote-job-aggregator). It can be used for programmatic validation of job candidates.
