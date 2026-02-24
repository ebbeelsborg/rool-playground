import { useEffect, useState } from "react";
import { RoolClient, RoolSpace } from "@rool-dev/sdk";
import type { RoolObject } from "@rool-dev/sdk";
import { extractTextFromPdf } from "./pdfUtils";

const SPACE_NAME = "Remote Job Harvest";
const RESUME_OBJECT_ID = "job-matcher-resume";

const MATCH_PROMPT = `You have a resume and a job listing. Rate how well the resume matches the job from 0-100 (percentage). Consider: relevant experience, skills overlap, seniority fit, and domain alignment. Be strict - only high matches get 70+.

Also extract 10-25 keywords from the job that represent required technical skills or soft skills. Create keyword objects with:
- type: "keyword"
- text: the keyword/skill
- priority: "high" | "medium" | "low" (high = must-have, medium = important, low = nice-to-have)

Link each keyword to the job via the "hasKeyword" relation. Pick the most important ones and assign priorities accordingly.`;

export default function App() {
  const [client, setClient] = useState<RoolClient | null>(null);
  const [space, setSpace] = useState<RoolSpace | null>(null);
  const [authState, setAuthState] = useState<"loading" | "unauthenticated" | "ready">("loading");
  const [jobs, setJobs] = useState<RoolObject[]>([]);
  const [resumeText, setResumeText] = useState<string | null>(null);
  const [matching, setMatching] = useState(false);
  const [matchProgress, setMatchProgress] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  useEffect(() => {
    const roolClient = new RoolClient();
    setClient(roolClient);

    roolClient.initialize().then((authenticated) => {
      setAuthState(authenticated ? "ready" : "unauthenticated");
    });

    return () => {
      roolClient.destroy();
    };
  }, []);

  useEffect(() => {
    if (authState !== "ready" || !client) return;

    let mounted = true;
    let currentSpace: RoolSpace | null = null;

    (async () => {
      const spaces = await client.listSpaces();
      const existing = spaces.find((s) => s.name === SPACE_NAME);
      const s = existing
        ? await client.openSpace(existing.id)
        : await client.createSpace(SPACE_NAME);
      if (!mounted) {
        s.close();
        return;
      }
      currentSpace = s;
      setSpace(s);

      const refresh = async () => {
        const jobRes = await s.findObjects({
          where: { type: "job" },
          limit: 200,
        });
        if (mounted) setJobs(jobRes.objects);
      };
      const onObjectChange = () => refresh();
      await refresh();

      s.on("objectCreated", onObjectChange);
      s.on("objectUpdated", onObjectChange);

      return () => {
        s.off("objectCreated", onObjectChange);
        s.off("objectUpdated", onObjectChange);
        s.close();
      };
    })();

    return () => {
      mounted = false;
      currentSpace?.close();
    };
  }, [authState, client]);

  const handleLogin = () => {
    client?.login("Job Matcher");
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !space) return;
    try {
      const text = await extractTextFromPdf(file);
      setResumeText(text);
      const existing = await space.getObject(RESUME_OBJECT_ID);
      if (existing) {
        await space.updateObject(RESUME_OBJECT_ID, {
          data: { text, updatedAt: Date.now() },
          ephemeral: true,
        });
      } else {
        await space.createObject({
          data: {
            id: RESUME_OBJECT_ID,
            type: "resume",
            text,
            updatedAt: Date.now(),
          },
        });
      }
    } catch (err) {
      console.error(err);
      setResumeText(null);
    }
    setFileInputKey((k) => k + 1);
  };

  const handleMatchAll = async () => {
    if (!space || !resumeText) return;
    setMatching(true);
    const jobsToMatch = jobs.filter((j) => j.status !== "discarded");
    for (let i = 0; i < jobsToMatch.length; i++) {
      const job = jobsToMatch[i];
      setMatchProgress(`Matching ${i + 1}/${jobsToMatch.length}: ${job.title}`);
      try {
        const { message } = await space.prompt(MATCH_PROMPT, {
          objectIds: [job.id, RESUME_OBJECT_ID],
          effort: "REASONING",
          responseSchema: {
            type: "object",
            properties: {
              match: { type: "number", description: "Match percentage 0-100" },
            },
            required: ["match"],
          },
        });
        const parsed = JSON.parse(message || "{}");
        const match = typeof parsed.match === "number" ? parsed.match : 0;
        await space.updateObject(job.id, {
          data: { matchScore: match },
          ephemeral: true,
        });
      } catch (err) {
        console.error("Match failed for", job.id, err);
      }
    }
    setMatchProgress(null);
    setMatching(false);
    const jobRes = await space.findObjects({ where: { type: "job" }, limit: 200 });
    setJobs(jobRes.objects);
  };

  const sortedJobs = [...jobs]
    .filter((j) => j.status !== "discarded")
    .sort((a, b) => (Number(b.matchScore) ?? 0) - (Number(a.matchScore) ?? 0));

  if (authState === "loading") {
    return (
      <div style={styles.center}>
        <p>Connecting to Rool...</p>
      </div>
    );
  }

  if (authState === "unauthenticated") {
    return (
      <div style={styles.center}>
        <div style={styles.card}>
          <h1 style={styles.title}>Job Matcher</h1>
          <p style={styles.subtitle}>
            Sign in to Rool to match your resume against harvested jobs.
          </p>
          <button style={styles.button} onClick={handleLogin}>
            Sign in to Rool
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.logo}>Job Matcher</h1>
        <div style={styles.uploadRow}>
          <label style={styles.uploadLabel}>
            <input
              key={fileInputKey}
              type="file"
              accept=".pdf"
              onChange={handleFileUpload}
              style={{ display: "none" }}
            />
            Upload Resume (PDF)
          </label>
          {resumeText && (
            <span style={styles.uploadStatus}>
              ✓ Resume loaded ({resumeText.length} chars)
            </span>
          )}
        </div>
      </header>

      <main style={styles.main}>
        <div style={styles.actions}>
          <button
            style={{ ...styles.button, ...styles.primaryButton }}
            onClick={handleMatchAll}
            disabled={matching || !resumeText || jobs.length === 0}
          >
            {matching ? "Matching…" : "Match All Jobs"}
          </button>
          {matchProgress && (
            <span style={styles.progress}>{matchProgress}</span>
          )}
        </div>

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>
            Jobs by match score ({sortedJobs.length})
          </h2>
          <ul style={styles.list}>
            {sortedJobs.map((j) => (
              <JobMatchCard key={j.id} job={j} space={space} />
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

function JobMatchCard({ job, space }: { job: RoolObject; space: RoolSpace | null }) {
  const [keywords, setKeywords] = useState<RoolObject[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!space || !expanded) return;
    space.getChildren(job.id, "hasKeyword").then(setKeywords);
  }, [space, job.id, expanded]);

  const matchScore = Number(job.matchScore);
  const scoreColor =
    matchScore >= 70 ? "#22c55e" : matchScore >= 50 ? "#eab308" : "#71717a";

  return (
    <li style={styles.jobItem}>
      <div style={styles.jobHeader}>
        <div>
          <strong>{String(job.title ?? "Unknown")}</strong>
          <span style={styles.meta}>{String(job.companyName ?? "")}</span>
        </div>
        <div style={styles.scoreBadge}>
          <span style={{ ...styles.score, color: scoreColor }}>
            {Number.isNaN(matchScore) ? "—" : `${matchScore}%`}
          </span>
        </div>
      </div>
      {job.url && (
        <a
          href={String(job.url)}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.link}
        >
          Apply
        </a>
      )}
      <button
        style={styles.keywordsToggle}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? "Hide" : "Show"} keywords
      </button>
      {expanded && keywords.length > 0 && (
        <div style={styles.keywords}>
          {keywords.map((k) => (
            <span
              key={k.id}
              style={{
                ...styles.keyword,
                ...(k.priority === "high"
                  ? styles.keywordHigh
                  : k.priority === "medium"
                    ? styles.keywordMedium
                    : styles.keywordLow),
              }}
            >
              {String(k.text)}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

const styles: Record<string, React.CSSProperties> = {
  center: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    padding: 24,
  },
  card: {
    background: "#18181b",
    borderRadius: 12,
    padding: 32,
    maxWidth: 400,
    textAlign: "center",
  },
  title: { margin: "0 0 8px", fontSize: 24 },
  subtitle: { margin: "0 0 24px", color: "#a1a1aa", fontSize: 14 },
  button: {
    padding: "12px 24px",
    fontSize: 16,
    background: "#27272a",
    color: "#e4e4e7",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  primaryButton: { background: "#3b82f6", color: "white" },
  container: { maxWidth: 800, margin: "0 auto", padding: 24 },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
    flexWrap: "wrap",
    gap: 12,
  },
  logo: { margin: 0, fontSize: 24 },
  uploadRow: { display: "flex", alignItems: "center", gap: 12 },
  uploadLabel: {
    padding: "8px 16px",
    background: "#27272a",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 14,
  },
  uploadStatus: { fontSize: 13, color: "#22c55e" },
  main: {},
  actions: { display: "flex", alignItems: "center", gap: 16, marginBottom: 24 },
  progress: { fontSize: 14, color: "#a1a1aa" },
  section: { background: "#18181b", borderRadius: 12, padding: 20 },
  sectionTitle: { margin: "0 0 16px", fontSize: 18 },
  list: { margin: 0, padding: 0, listStyle: "none" },
  jobItem: {
    padding: "16px 0",
    borderBottom: "1px solid #27272a",
  },
  jobHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  meta: { display: "block", fontSize: 13, color: "#a1a1aa" },
  scoreBadge: { flexShrink: 0 },
  score: { fontSize: 18, fontWeight: 600 },
  link: { color: "#3b82f6", fontSize: 13, display: "inline-block", marginTop: 8 },
  keywordsToggle: {
    marginTop: 8,
    padding: "4px 0",
    background: "none",
    border: "none",
    color: "#a1a1aa",
    fontSize: 13,
    cursor: "pointer",
  },
  keywords: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 },
  keyword: {
    padding: "4px 10px",
    borderRadius: 6,
    fontSize: 12,
  },
  keywordHigh: { background: "#3b82f6", color: "white" },
  keywordMedium: { background: "#6b7280", color: "white" },
  keywordLow: { background: "#27272a", color: "#a1a1aa" },
};
