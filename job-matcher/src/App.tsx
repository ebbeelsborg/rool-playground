import { useEffect, useState } from "react";
import { RoolClient, RoolSpace } from "@rool-dev/sdk";
import type { RoolObject } from "@rool-dev/sdk";
import { Briefcase, FileText, Loader2, ChevronDown, ChevronRight, Sun, Moon, Monitor } from "lucide-react";
import { extractTextFromPdf } from "./pdfUtils";

const SPACE_NAME = "Remote Job Harvest";
const RESUME_OBJECT_ID = "job-matcher-resume";
const RESUME_CONFIG_ID = "job-matcher-resume-config";

const MATCH_PROMPT = `You have a resume and a job listing. Rate how well the resume matches the job from 0-100 (percentage). Consider: relevant experience, skills overlap, seniority fit, and domain alignment. Be strict - only high matches get 70+.

Update the job object with:
1) matchScore: the match percentage (0-100)
2) keywords: array of {text: string, priority: "high"|"medium"|"low"} - extract 10-25 skills/techs from the job. High = must-have, medium = important, low = nice-to-have.`;

type Section = "jobs" | "resumes";

type LogEntry = {
  id: string;
  timestamp: number;
  type: "progress" | "result" | "error";
  message: string;
};

function ensureVersionHistory(
  v: unknown
): { version: number; text: string; createdAt: number }[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (
      x
    ): x is { version: number; text: string; createdAt: number } =>
      typeof x === "object" &&
      x !== null &&
      typeof (x as { version?: unknown }).version === "number"
  );
}

export default function App() {
  const [client, setClient] = useState<RoolClient | null>(null);
  const [space, setSpace] = useState<RoolSpace | null>(null);
  const [authState, setAuthState] = useState<
    "loading" | "unauthenticated" | "ready"
  >("loading");
  const [jobs, setJobs] = useState<RoolObject[]>([]);
  const [section, setSection] = useState<Section>("jobs");
  const [resumeConfig, setResumeConfig] = useState<{
    currentText: string;
    currentVersion: number;
    versionHistory: { version: number; text: string; createdAt: number }[];
  } | null>(null);
  const [matching, setMatching] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logPanelOpen, setLogPanelOpen] = useState(true);
  const [resumeVersionDetail, setResumeVersionDetail] = useState<{
    version: number;
    text: string;
  } | null>(null);
  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    const s = localStorage.getItem("job-matcher-theme");
    return (s === "light" || s === "dark" || s === "system" ? s : "dark") as "light" | "dark" | "system";
  });

  const addLog = (type: LogEntry["type"], message: string) => {
    setLogEntries((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: Date.now(),
        type,
        message,
      },
    ]);
  };

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
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      root.classList.toggle("dark", dark);
      root.classList.toggle("light", !dark);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

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

      const ensureResumeConfig = async () => {
        const [cfg, resume] = await Promise.all([
          s.getObject(RESUME_CONFIG_ID),
          s.getObject(RESUME_OBJECT_ID),
        ]);
        if (!cfg) {
          const existingText = String(resume?.text ?? "").trim();
          const hasExisting = existingText.length > 0;
          await s.createObject({
            data: {
              id: RESUME_CONFIG_ID,
              type: "resumeConfig",
              currentText: existingText,
              currentVersion: hasExisting ? 1 : 0,
              versionHistory: hasExisting
                ? [{ version: 1, text: existingText, createdAt: Date.now() }]
                : [],
            },
          });
        }
      };
      await ensureResumeConfig();

      const refresh = async () => {
        const [jobRes, cfgRes] = await Promise.all([
          s.findObjects({ where: { type: "job" }, limit: 200 }),
          s.getObject(RESUME_CONFIG_ID),
        ]);
        if (mounted) {
          setJobs(jobRes.objects);
          const cfg = cfgRes;
          if (cfg) {
            setResumeConfig({
              currentText: String(cfg.currentText ?? ""),
              currentVersion: Number(cfg.currentVersion ?? 0),
              versionHistory: ensureVersionHistory(cfg.versionHistory),
            });
          }
        }
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
      addLog("progress", `Resume extracted: ${text.length} characters`);

      const cfg = await space.getObject(RESUME_CONFIG_ID);
      const currentVersion = Number(cfg?.currentVersion ?? 0);
      const history = ensureVersionHistory(cfg?.versionHistory ?? []);
      const newVersion = currentVersion + 1;
      const newHistory = [
        ...history,
        { version: newVersion, text, createdAt: Date.now() },
      ];

      const existingResume = await space.getObject(RESUME_OBJECT_ID);
      if (existingResume) {
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

      await space.updateObject(RESUME_CONFIG_ID, {
        data: {
          currentText: text,
          currentVersion: newVersion,
          versionHistory: newHistory,
        },
        ephemeral: true,
      });

      setResumeConfig({
        currentText: text,
        currentVersion: newVersion,
        versionHistory: newHistory,
      });
      addLog("result", `Resume v${newVersion} saved`);
    } catch (err) {
      addLog("error", err instanceof Error ? err.message : "Upload failed");
    }
    setFileInputKey((k) => k + 1);
  };

  const handleMatchAll = async () => {
    if (!space || !resumeConfig?.currentText) return;
    const jobsToMatch = jobs.filter((j) => j.status !== "discarded");
    if (jobsToMatch.length === 0) {
      addLog("error", "No jobs to match");
      return;
    }

    setMatching(true);
    addLog("progress", `Starting match for ${jobsToMatch.length} jobs`);

    for (let i = 0; i < jobsToMatch.length; i++) {
      const job = jobsToMatch[i];
      const jobTitle = String(job.title ?? "Unknown");
      addLog("progress", `Matching ${i + 1}/${jobsToMatch.length}: ${jobTitle}`);

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

        addLog(
          "result",
          `${jobTitle}: ${match}% match`
        );
      } catch (err) {
        addLog(
          "error",
          `${jobTitle}: ${err instanceof Error ? err.message : "Match failed"}`
        );
      }
    }

    addLog("result", `Match complete for ${jobsToMatch.length} jobs`);
    setMatching(false);

    const jobRes = await space.findObjects({
      where: { type: "job" },
      limit: 200,
    });
    setJobs(jobRes.objects);
  };

  const handleResumeRestore = async (v: { version: number; text: string }) => {
    if (!space) return;
    const cfg = await space.getObject(RESUME_CONFIG_ID);
    const history = ensureVersionHistory(cfg?.versionHistory ?? []);

    const existingResume = await space.getObject(RESUME_OBJECT_ID);
    if (existingResume) {
      await space.updateObject(RESUME_OBJECT_ID, {
        data: { text: v.text, updatedAt: Date.now() },
        ephemeral: true,
      });
    } else {
      await space.createObject({
        data: {
          id: RESUME_OBJECT_ID,
          type: "resume",
          text: v.text,
          updatedAt: Date.now(),
        },
      });
    }

    await space.updateObject(RESUME_CONFIG_ID, {
      data: {
        currentText: v.text,
        currentVersion: v.version,
        versionHistory: history,
      },
      ephemeral: true,
    });

    setResumeConfig({
      currentText: v.text,
      currentVersion: v.version,
      versionHistory: history,
    });
    setResumeVersionDetail(null);
    addLog("result", `Restored resume v${v.version}`);
  };

  const sortedJobs = [...jobs]
    .filter((j) => j.status !== "discarded")
    .sort((a, b) => (Number(b.matchScore) ?? 0) - (Number(a.matchScore) ?? 0));

  const hasResume = (resumeConfig?.currentText?.length ?? 0) > 0;
  const resumeHistory = [...(resumeConfig?.versionHistory ?? [])].reverse();

  if (authState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-zinc-400">Connecting to Rool...</p>
      </div>
    );
  }

  if (authState === "unauthenticated") {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md rounded-xl bg-zinc-900 p-8 text-center">
          <h1 className="mb-2 text-2xl font-semibold">Job Matcher</h1>
          <p className="mb-6 text-zinc-400">
            Sign in to Rool to match your resume against harvested jobs.
          </p>
          <button
            className="rounded-lg bg-blue-600 px-6 py-3 font-medium text-white hover:bg-blue-700"
            onClick={handleLogin}
          >
            Sign in to Rool
          </button>
        </div>
      </div>
    );
  }

  const navItems: { id: Section; label: string; icon: React.ElementType }[] = [
    { id: "jobs", label: "Jobs", icon: Briefcase },
    { id: "resumes", label: "Resumes", icon: FileText },
  ];

  return (
    <div className="flex min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Left Sidebar */}
      <aside className="flex w-64 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/80">
        <div className="border-b border-zinc-800 p-4">
          <h1 className="text-lg font-semibold">Job Matcher</h1>
        </div>
        <nav className="flex-1 space-y-1 p-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setSection(item.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  section === item.id
                    ? "bg-blue-600/20 text-blue-400"
                    : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="border-t border-zinc-800 p-2">
          <button
            onClick={handleMatchAll}
            disabled={matching || !hasResume || jobs.length === 0}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {matching ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Matching…
              </>
            ) : (
              "Match All Jobs"
            )}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <div className="flex items-center gap-4">
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            {section === "jobs" && "Jobs"}
            {section === "resumes" && "Resumes"}
          </h2>
          <button
            onClick={handleMatchAll}
            disabled={matching || !hasResume || jobs.filter((j) => j.status !== "discarded").length === 0}
            className="flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {matching ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Matching…
              </>
            ) : (
              "Match All Jobs"
            )}
          </button>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-700 dark:bg-zinc-800">
            <button
              onClick={() => {
                setTheme("light");
                localStorage.setItem("job-matcher-theme", "light");
              }}
              title="Light"
              className={`rounded p-1.5 ${
                theme === "light"
                  ? "bg-white text-blue-600 shadow dark:bg-zinc-700 dark:text-blue-400"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              <Sun className="h-4 w-4" />
            </button>
            <button
              onClick={() => {
                setTheme("dark");
                localStorage.setItem("job-matcher-theme", "dark");
              }}
              title="Dark"
              className={`rounded p-1.5 ${
                theme === "dark"
                  ? "bg-white text-blue-600 shadow dark:bg-zinc-700 dark:text-blue-400"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              <Moon className="h-4 w-4" />
            </button>
            <button
              onClick={() => {
                setTheme("system");
                localStorage.setItem("job-matcher-theme", "system");
              }}
              title="System"
              className={`rounded p-1.5 ${
                theme === "system"
                  ? "bg-white text-blue-600 shadow dark:bg-zinc-700 dark:text-blue-400"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              <Monitor className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {/* Center content */}
          <div className="flex-1 overflow-auto p-6">
            {section === "jobs" && <JobsSection jobs={sortedJobs} />}
            {section === "resumes" && (
              <ResumesSection
                resumeConfig={resumeConfig}
                fileInputKey={fileInputKey}
                onFileUpload={handleFileUpload}
              onRestore={handleResumeRestore}
              versionDetail={resumeVersionDetail}
              setVersionDetail={setResumeVersionDetail}
            />
            )}
          </div>

          {/* Right LLM Log panel */}
          <div className="flex w-80 flex-col border-l border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50">
            <button
              onClick={() => setLogPanelOpen((o) => !o)}
              className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
            >
              <span className="font-medium">
                {matching ? "LLM working…" : "LLM log"}
              </span>
              {logPanelOpen ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            {logPanelOpen && (
              <div className="flex-1 overflow-auto border-t border-zinc-800 p-3">
                <div className="space-y-2">
                  {logEntries.length === 0 ? (
                    <p className="text-sm text-zinc-500">
                      Match jobs or upload a resume to see activity here.
                    </p>
                  ) : (
                    logEntries.map((entry) => (
                      <div
                        key={entry.id}
                        className={`rounded px-2 py-1.5 text-xs ${
                          entry.type === "error"
                            ? "bg-red-500/10 text-red-400"
                            : entry.type === "result"
                              ? "bg-green-500/10 text-green-400"
                              : "bg-zinc-800/50 text-zinc-400"
                        }`}
                      >
                        <span className="text-zinc-500">
                          {new Date(entry.timestamp).toLocaleTimeString()}{" "}
                        </span>
                        {entry.message}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Resume version detail modal */}
      {resumeVersionDetail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setResumeVersionDetail(null)}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-zinc-900 p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-lg font-semibold">
              Resume version {resumeVersionDetail.version}
            </h3>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-700 bg-zinc-800 p-4 text-sm text-zinc-300">
              {resumeVersionDetail.text}
            </pre>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-lg border border-zinc-600 px-4 py-2 text-sm hover:bg-zinc-800"
                onClick={() => setResumeVersionDetail(null)}
              >
                Close
              </button>
              <button
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
                onClick={() => {
                  handleResumeRestore(resumeVersionDetail);
                }}
              >
                Restore
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function JobsSection({ jobs }: { jobs: RoolObject[] }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Jobs sorted by match score. Upload a resume and run Match All to score.
      </p>
      <ul className="space-y-2">
        {jobs.map((j) => (
          <JobMatchCard key={j.id} job={j} />
        ))}
      </ul>
      {jobs.length === 0 && (
        <p className="py-8 text-center text-zinc-500">
          No jobs yet. Harvest jobs in the Job Harvester app first.
        </p>
      )}
    </div>
  );
}

type JobTag = { text: string; priority?: string };

function getJobTags(job: RoolObject): JobTag[] {
  const kw = job.keywords;
  if (!Array.isArray(kw)) return [];
  return kw.filter(
    (x): x is JobTag =>
      typeof x === "object" && x !== null && typeof (x as JobTag).text === "string"
  );
}

function JobMatchCard({ job }: { job: RoolObject }) {
  const tags = getJobTags(job);
  const matchScore = Number(job.matchScore);
  const scoreColor =
    matchScore >= 70
      ? "text-green-500"
      : matchScore >= 50
        ? "text-yellow-500"
        : "text-zinc-500";

  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50 dark:shadow-none">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <strong className="text-zinc-900 dark:text-zinc-200">{String(job.title ?? "Unknown")}</strong>
          <p className="mt-1 text-sm text-zinc-500">
            {String(job.companyName ?? "")}
          </p>
          {job.url && (
            <a
              href={String(job.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-sm text-blue-400 hover:underline"
            >
              Apply →
            </a>
          )}
        </div>
        <div className="shrink-0">
          <span
            className={`text-lg font-semibold ${
              Number.isNaN(matchScore) ? "text-zinc-500" : scoreColor
            }`}
          >
            {Number.isNaN(matchScore) ? "—" : `${matchScore}%`}
          </span>
        </div>
      </div>
      {tags.length > 0 && (
        <div className="mt-3">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Tags:</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {tags.map((k, i) => (
              <span
                key={i}
                className={`rounded px-2 py-0.5 text-xs ${
                  k.priority === "high"
                    ? "bg-blue-100 text-blue-700 dark:bg-blue-600/20 dark:text-blue-400"
                    : k.priority === "medium"
                      ? "bg-zinc-200 text-zinc-700 dark:bg-zinc-600/20 dark:text-zinc-400"
                      : "bg-zinc-100 text-zinc-600 dark:bg-zinc-700/20 dark:text-zinc-500"
                }`}
              >
                {String(k.text)}
              </span>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

function ResumesSection({
  resumeConfig,
  fileInputKey,
  onFileUpload,
  onRestore,
  versionDetail,
  setVersionDetail,
  onMatchAll,
  matching,
  hasResume,
  jobsCount,
}: {
  resumeConfig: {
    currentText: string;
    currentVersion: number;
    versionHistory: { version: number; text: string; createdAt: number }[];
  } | null;
  fileInputKey: number;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRestore: (v: { version: number; text: string }) => void;
  versionDetail: { version: number; text: string } | null;
  setVersionDetail: (v: { version: number; text: string } | null) => void;
}) {
  const text = resumeConfig?.currentText ?? "";
  const version = resumeConfig?.currentVersion ?? 0;
  const history = [...(resumeConfig?.versionHistory ?? [])].reverse();

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <h3 className="mb-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Current resume {version > 0 ? `(v${version})` : ""}
        </h3>
        {text ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm text-zinc-600 dark:text-zinc-300">
            {text.slice(0, 400)}
            {text.length > 400 ? "…" : ""}
          </pre>
        ) : (
          <p className="text-sm text-zinc-500">No resume uploaded yet.</p>
        )}
        <label className="mt-3 inline-block cursor-pointer rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
          <input
            key={fileInputKey}
            type="file"
            accept=".pdf"
            onChange={onFileUpload}
            className="hidden"
          />
          Upload Resume (PDF)
        </label>
      </div>

      {history.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-medium text-zinc-400">
            Version history
          </h3>
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/50">
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">
                    Version
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">
                    Content (truncated)
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">
                    Date
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-zinc-400">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.map((v) => (
                  <tr
                    key={v.version}
                    className="border-b border-zinc-800/50 last:border-0"
                  >
                    <td className="px-4 py-3 font-mono text-zinc-300">
                      v{v.version}
                    </td>
                    <td className="max-w-md px-4 py-3">
                      <button
                        onClick={() => setVersionDetail(v)}
                        className="text-left text-zinc-400 hover:text-blue-400 hover:underline"
                      >
                        {v.text.slice(0, 80)}
                        {v.text.length > 80 ? "…" : ""}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-zinc-500">
                      {new Date(v.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => onRestore(v)}
                        className="text-blue-400 hover:text-blue-300"
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
