# Vercel Deployment Setup

This repo contains two apps. To deploy both with separate URLs, create **two Vercel projects** from the same repo.

## Option A: Vercel Dashboard (recommended)

1. Go to [vercel.com/new](https://vercel.com/new) and import your repo.

2. **Project 1 – Job Harvester**
   - **Project Name:** `job-harvester` (or your choice)
   - **Root Directory:** `job-harvester` (click “Edit” and set this)
   - **Framework Preset:** Vite (auto-detected)
   - Deploy

3. **Project 2 – Job Matcher**
   - Create another project: **Add New Project** → select the same repo again
   - **Project Name:** `job-matcher` (or your choice)
   - **Root Directory:** `job-matcher` (click “Edit” and set this)
   - **Framework Preset:** Vite (auto-detected)
   - Deploy

Each project will have its own URL (e.g. `job-harvester-xxx.vercel.app` and `job-matcher-xxx.vercel.app`).

## Option B: Vercel CLI

```bash
# Deploy Job Harvester
cd job-harvester && vercel deploy --prod

# Deploy Job Matcher (from repo root)
cd job-matcher && vercel deploy --prod
```

When prompted, link each to a new project or use the same project with different root directories.
