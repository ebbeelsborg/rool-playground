import { useEffect, useState } from "react";
import { RoolClient, RoolChannel } from "@rool-dev/sdk";
import type { RoolObject } from "@rool-dev/sdk";
import { Briefcase, FileText, BarChart3, Loader2, ChevronDown, ChevronRight, Sun, Moon, Monitor, Check, XCircle } from "lucide-react";
import { extractTextFromPdf } from "./pdfUtils";

const SPACE_NAME = "Remote Job Harvest";
const RESUME_OBJECT_ID = "job-matcher-resume";
const RESUME_CONFIG_ID = "job-matcher-resume-config";
const MATCHER_STATS_ID = "job-matcher-stats";
const EXTRACT_KEYWORDS_PROMPT = `Extract all skills and technologies from the resume object. Return a JSON object with a "keywords" array of strings. Include: programming languages, frameworks, tools, methodologies, and relevant technical terms. Normalize variations (e.g. "React" not "React.js").`;

type Section = "jobs" | "resumes" | "stats";

type JobTag = { text: string; priority?: string };

type ResumeVersion = {
  version: number;
  text: string;
  createdAt: number;
  keywords?: string[];
};

function getJobTags(job: RoolObject): JobTag[] {
  const kw = job.keywords;
  if (!Array.isArray(kw)) return [];
  return kw.filter(
    (x): x is JobTag =>
      typeof x === "object" && x !== null && typeof (x as JobTag).text === "string"
  );
}

function getCurrentResumeKeywords(config: {
  currentVersion: number;
  versionHistory: ResumeVersion[];
}): Set<string> {
  const entry = config.versionHistory.find((v) => v.version === config.currentVersion);
  const kw = entry?.keywords ?? [];
  return new Set(kw.map((k) => String(k).toLowerCase().trim()).filter(Boolean));
}

function computeMatchScore(tags: JobTag[], resumeKeywords: Set<string>): number {
  if (tags.length === 0) return 0;
  let matched = 0;
  for (const tag of tags) {
    const normalized = String(tag.text).toLowerCase().trim();
    if (resumeKeywords.has(normalized)) matched++;
  }
  return Math.round((matched / tags.length) * 100);
}

type LogEntry = {
  id: string;
  timestamp: number;
  type: "progress" | "result" | "error";
  message: string;
};

function ensureVersionHistory(v: unknown): ResumeVersion[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is ResumeVersion =>
      typeof x === "object" &&
      x !== null &&
      typeof (x as { version?: unknown }).version === "number"
  );
}

export default function App() {
  const [client, setClient] = useState<RoolClient | null>(null);
  const [channel, setChannel] = useState<RoolChannel | null>(null);
  const [authState, setAuthState] = useState<
    "loading" | "unauthenticated" | "ready"
  >("loading");
  const [jobs, setJobs] = useState<RoolObject[]>([]);
  const [section, setSection] = useState<Section>("jobs");
  const [resumeConfig, setResumeConfig] = useState<{
    currentText: string;
    currentVersion: number;
    versionHistory: ResumeVersion[];
  } | null>(null);
  const [matching, setMatching] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logPanelOpen, setLogPanelOpen] = useState(true);
  const [resumeVersionDetail, setResumeVersionDetail] = useState<{
    version: number;
    text: string;
    keywords?: string[];
  } | null>(null);
  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    const s = localStorage.getItem("job-matcher-theme");
    return (s === "light" || s === "dark" || s === "system" ? s : "dark") as "light" | "dark" | "system";
  });
  const [matchesRun, setMatchesRun] = useState(0);

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
    let currentChannel: RoolChannel | null = null;

    (async () => {
      const spaces = await client.listSpaces();
      const existing = spaces.find((s) => s.name === SPACE_NAME);
      const space = existing
        ? await client.openSpace(existing.id)
        : await client.createSpace(SPACE_NAME);
      const ch = await space.openChannel("main");
      if (!mounted) {
        ch.close();
        return;
      }
      currentChannel = ch;
      setChannel(ch);

      const ensureResumeConfig = async () => {
        const [cfg, resume] = await Promise.all([
          ch.getObject(RESUME_CONFIG_ID),
          ch.getObject(RESUME_OBJECT_ID),
        ]);
        if (!cfg) {
          const existingText = String(resume?.text ?? "").trim();
          const hasExisting = existingText.length > 0;
          await ch.createObject({
            data: {
              id: RESUME_CONFIG_ID,
              type: "resumeConfig",
              currentText: existingText,
              currentVersion: hasExisting ? 1 : 0,
              versionHistory: hasExisting
                ? [{ version: 1, text: existingText, createdAt: Date.now(), keywords: [] }]
                : [],
            },
          });
        }
      };
      await ensureResumeConfig();

      const ensureMatcherStats = async () => {
        const stats = await ch.getObject(MATCHER_STATS_ID);
        if (!stats) {
          await ch.createObject({
            data: {
              id: MATCHER_STATS_ID,
              type: "matcherStats",
              matchRunCount: 0,
            },
          });
        }
      };
      await ensureMatcherStats();

      const refresh = async () => {
        const [jobRes, cfgRes, statsRes] = await Promise.all([
          ch.findObjects({ where: { type: "job" }, limit: 200 }),
          ch.getObject(RESUME_CONFIG_ID),
          ch.getObject(MATCHER_STATS_ID),
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
          setMatchesRun(Number(statsRes?.matchRunCount ?? 0));
        }
      };
      const onObjectChange = () => refresh();
      await refresh();

      ch.on("objectCreated", onObjectChange);
      ch.on("objectUpdated", onObjectChange);

      return () => {
        ch.off("objectCreated", onObjectChange);
        ch.off("objectUpdated", onObjectChange);
        ch.close();
      };
    })();

    return () => {
      mounted = false;
      currentChannel?.close();
    };
  }, [authState, client]);

  const handleLogin = () => {
    client?.login("Job Matcher");
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !channel) return;
    try {
      const text = await extractTextFromPdf(file);
      addLog("progress", `Resume extracted: ${text.length} characters`);

      const existingResume = await channel.getObject(RESUME_OBJECT_ID);
      if (existingResume) {
        await channel.updateObject(RESUME_OBJECT_ID, {
          data: { text, updatedAt: Date.now() },
          ephemeral: true,
        });
      } else {
        await channel.createObject({
          data: {
            id: RESUME_OBJECT_ID,
            type: "resume",
            text,
            updatedAt: Date.now(),
          },
        });
      }

      addLog("progress", "Extracting keywords from resume…");
      const { message } = await channel.prompt(EXTRACT_KEYWORDS_PROMPT, {
        objectIds: [RESUME_OBJECT_ID],
        effort: "REASONING",
        responseSchema: {
          type: "object",
          properties: {
            keywords: {
              type: "array",
              items: { type: "string" },
              description: "Skills and technologies from the resume",
            },
          },
          required: ["keywords"],
        },
      });

      let keywords: string[] = [];
      try {
        const parsed = JSON.parse(message || "{}");
        if (Array.isArray(parsed.keywords)) {
          keywords = parsed.keywords.filter((k: unknown) => typeof k === "string");
        }
      } catch {
        addLog("error", "Could not parse extracted keywords");
      }
      addLog("result", `Extracted ${keywords.length} keywords`);

      const cfg = await channel.getObject(RESUME_CONFIG_ID);
      const currentVersion = Number(cfg?.currentVersion ?? 0);
      const history = ensureVersionHistory(cfg?.versionHistory ?? []);
      const newVersion = currentVersion + 1;
      const newHistory: ResumeVersion[] = [
        ...history,
        { version: newVersion, text, createdAt: Date.now(), keywords },
      ];

      await channel.updateObject(RESUME_CONFIG_ID, {
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
      addLog("result", `Resume v${newVersion} saved with ${keywords.length} keywords`);
    } catch (err) {
      addLog("error", err instanceof Error ? err.message : "Upload failed");
    }
    setFileInputKey((k) => k + 1);
  };

  const handleMatchAll = async () => {
    if (!space || !resumeConfig) return;
    let resumeKeywords = getCurrentResumeKeywords(resumeConfig);
    if (resumeKeywords.size === 0 && (resumeConfig.currentText?.length ?? 0) > 0) {
      addLog("progress", "Resume exists but keywords missing. Extracting keywords…");
      const resume = await channel.getObject(RESUME_OBJECT_ID);
      if (resume?.text) {
        try {
          const { message } = await channel.prompt(EXTRACT_KEYWORDS_PROMPT, {
            objectIds: [RESUME_OBJECT_ID],
            effort: "REASONING",
            responseSchema: {
              type: "object",
              properties: {
                keywords: {
                  type: "array",
                  items: { type: "string" },
                  description: "Skills and technologies from the resume",
                },
              },
              required: ["keywords"],
            },
          });
          let keywords: string[] = [];
          try {
            const parsed = JSON.parse(message || "{}");
            if (Array.isArray(parsed.keywords)) {
              keywords = parsed.keywords.filter((k: unknown) => typeof k === "string");
            }
          } catch {
            addLog("error", "Could not parse extracted keywords");
          }
          if (keywords.length > 0) {
            const history = ensureVersionHistory(resumeConfig.versionHistory);
            const entryIdx = history.findIndex((v) => v.version === resumeConfig.currentVersion);
            if (entryIdx >= 0) {
              history[entryIdx] = { ...history[entryIdx], keywords };
            } else {
              history.push({
                version: resumeConfig.currentVersion,
                text: resumeConfig.currentText,
                createdAt: Date.now(),
                keywords,
              });
            }
            await channel.updateObject(RESUME_CONFIG_ID, {
              data: { versionHistory: history },
              ephemeral: true,
            });
            setResumeConfig({ ...resumeConfig, versionHistory: history });
            resumeKeywords = new Set(keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean));
            addLog("result", `Extracted ${keywords.length} keywords from existing resume`);
          }
        } catch (err) {
          addLog("error", err instanceof Error ? err.message : "Keyword extraction failed");
        }
      }
    }
    if (resumeKeywords.size === 0) {
      addLog("error", "No resume keywords. Upload a resume first.");
      return;
    }
    const jobsToMatch = jobs.filter((j) => j.status !== "discarded");
    if (jobsToMatch.length === 0) {
      addLog("error", "No jobs to match");
      return;
    }

    setMatching(true);
    addLog("progress", `Matching ${jobsToMatch.length} jobs by keyword overlap`);

    for (let i = 0; i < jobsToMatch.length; i++) {
      const job = jobsToMatch[i];
      const jobTitle = String(job.title ?? "Unknown");
      const tags = getJobTags(job);
      const matchScore = computeMatchScore(tags, resumeKeywords);
      await channel.updateObject(job.id, {
        data: { matchScore },
        ephemeral: true,
      });
      addLog("result", `${jobTitle}: ${matchScore}% match`);
    }

    const stats = await channel.getObject(MATCHER_STATS_ID);
    const count = Number(stats?.matchRunCount ?? 0) + 1;
    await channel.updateObject(MATCHER_STATS_ID, {
      data: { matchRunCount: count },
      ephemeral: true,
    });
    setMatchesRun(count);

    addLog("result", `Match complete for ${jobsToMatch.length} jobs`);
    setMatching(false);

    const jobRes = await channel.findObjects({
      where: { type: "job" },
      limit: 200,
    });
    setJobs(jobRes.objects);
  };

  const handleResumeRestore = async (v: { version: number; text: string }) => {
    if (!space) return;
    const cfg = await channel.getObject(RESUME_CONFIG_ID);
    const history = ensureVersionHistory(cfg?.versionHistory ?? []);

    const existingResume = await channel.getObject(RESUME_OBJECT_ID);
    if (existingResume) {
      await channel.updateObject(RESUME_OBJECT_ID, {
        data: { text: v.text, updatedAt: Date.now() },
        ephemeral: true,
      });
    } else {
      await channel.createObject({
        data: {
          id: RESUME_OBJECT_ID,
          type: "resume",
          text: v.text,
          updatedAt: Date.now(),
        },
      });
    }

    await channel.updateObject(RESUME_CONFIG_ID, {
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
        <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          <h1 className="mb-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Job Matcher</h1>
          <p className="mb-6 text-zinc-500 dark:text-zinc-400">
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
    { id: "stats", label: "Stats", icon: BarChart3 },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Left Sidebar - fixed, full height, Run Match always visible at bottom */}
      <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/80">
        <div className="flex h-14 shrink-0 items-center border-b border-zinc-200 px-4 dark:border-zinc-800">
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
                    ? "bg-blue-600/20 text-blue-600 dark:text-blue-400"
                    : "text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="shrink-0 border-t border-zinc-200 p-2 dark:border-zinc-800">
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
              "Run Match"
            )}
          </button>
        </div>
      </aside>

      {/* Main content - scrolls independently */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 px-6 dark:border-zinc-800">
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            {section === "jobs" && "Jobs"}
            {section === "resumes" && "Resumes"}
            {section === "stats" && "Statistics"}
          </h2>
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

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Center content */}
          <div className="min-h-0 flex-1 overflow-auto p-6">
            {section === "jobs" && (
              <JobsSection
                jobs={sortedJobs}
                resumeKeywords={
                  resumeConfig
                    ? getCurrentResumeKeywords(resumeConfig)
                    : new Set<string>()
                }
              />
            )}
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
            {section === "stats" && (
              <StatsSection jobs={jobs} matchesRun={matchesRun} />
            )}
          </div>

          {/* Right LLM Log panel */}
          <div className="flex w-80 flex-col border-l border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50">
            <button
              onClick={() => setLogPanelOpen((o) => !o)}
              className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-zinc-500 hover:bg-zinc-300/50 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-200"
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
              <div className="flex-1 overflow-auto border-t border-zinc-200 p-3 dark:border-zinc-800">
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
                            ? "bg-red-500/10 text-red-600 dark:text-red-400"
                            : entry.type === "result"
                              ? "bg-green-500/10 text-green-600 dark:text-green-400"
                              : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400"
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
            className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Resume version {resumeVersionDetail.version}
            </h3>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {resumeVersionDetail.text}
            </pre>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
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

function getJobStatus(job: RoolObject): "inbox" | "saved" | "discarded" {
  const s = job.status as string | undefined;
  if (s === "saved" || s === "discarded") return s;
  return "inbox";
}

function StatsSection({
  jobs,
  matchesRun,
}: {
  jobs: RoolObject[];
  matchesRun: number;
}) {
  const inboxCount = jobs.filter((j) => getJobStatus(j) === "inbox").length;
  const savedCount = jobs.filter((j) => getJobStatus(j) === "saved").length;
  const discardedCount = jobs.filter((j) => getJobStatus(j) === "discarded").length;
  const total = inboxCount + savedCount + discardedCount;

  const pieData = [
    { label: "Inbox", count: inboxCount, color: "#3b82f6" },
    { label: "Saved", count: savedCount, color: "#eab308" },
    { label: "Ignored", count: discardedCount, color: "#ef4444" },
  ].filter((d) => d.count > 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Jobs matched</p>
          <p className="text-2xl font-semibold">{jobs.length}</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Matches run</p>
          <p className="text-2xl font-semibold">{matchesRun}</p>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <h3 className="mb-4 text-sm font-medium text-zinc-600 dark:text-zinc-400">
          Jobs by status
        </h3>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          {total > 0 && pieData.length > 0 ? (
            <>
              <PieChart data={pieData} total={total} />
              <ul className="flex flex-wrap gap-4">
                {pieData.map((d) => (
                  <li key={d.label} className="flex items-center gap-2">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: d.color }}
                    />
                    <span className="text-sm text-zinc-700 dark:text-zinc-300">
                      {d.label}: {d.count}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-zinc-500">No jobs yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function PieChart({
  data,
  total,
}: {
  data: { label: string; count: number; color: string }[];
  total: number;
}) {
  let startAngle = 0;
  const size = 120;

  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className="shrink-0">
      {data.map((d) => {
        const pct = d.count / total;
        const angle = pct * 360;
        const endAngle = startAngle + angle;
        const x1 = 50 + 50 * Math.cos((startAngle * Math.PI) / 180);
        const y1 = 50 + 50 * Math.sin((startAngle * Math.PI) / 180);
        const x2 = 50 + 50 * Math.cos((endAngle * Math.PI) / 180);
        const y2 = 50 + 50 * Math.sin((endAngle * Math.PI) / 180);
        const large = angle > 180 ? 1 : 0;
        const path = `M 50 50 L ${x1} ${y1} A 50 50 0 ${large} 1 ${x2} ${y2} Z`;
        startAngle = endAngle;
        return (
          <path
            key={d.label}
            d={path}
            fill={d.color}
            stroke="white"
            strokeWidth={2}
            className="dark:stroke-zinc-900"
          />
        );
      })}
    </svg>
  );
}

function JobsSection({
  jobs,
  resumeKeywords,
}: {
  jobs: RoolObject[];
  resumeKeywords: Set<string>;
}) {
  return (
    <div className="space-y-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Jobs sorted by match score. Upload a resume and run Match to score.
        </p>
        <ul className="space-y-2">
          {jobs.map((j) => (
            <JobMatchCard key={j.id} job={j} resumeKeywords={resumeKeywords} />
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

function JobMatchCard({
  job,
  resumeKeywords,
}: {
  job: RoolObject;
  resumeKeywords: Set<string>;
}) {
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
        <div className="relative shrink-0 group">
          <span
            className={`text-lg font-semibold cursor-help ${
              Number.isNaN(matchScore) ? "text-zinc-500" : scoreColor
            }`}
          >
            {Number.isNaN(matchScore) ? "—" : `${matchScore}%`}
          </span>
          {tags.length > 0 && (
            <div className="absolute right-0 top-full z-10 mt-1 hidden max-h-60 min-w-[200px] overflow-auto rounded-lg border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-800 group-hover:block">
              <p className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Skills match
              </p>
              <ul className="space-y-1.5 text-sm">
                {tags.map((k, i) => {
                  const normalized = String(k.text).toLowerCase().trim();
                  const matched = resumeKeywords.has(normalized);
                  return (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="text-zinc-700 dark:text-zinc-300">
                        {String(k.text)}
                      </span>
                      {matched ? (
                        <Check className="h-4 w-4 shrink-0 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 shrink-0 text-red-500" />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
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
                  k.priority === "required"
                    ? "bg-blue-100 text-blue-700 dark:bg-blue-600/20 dark:text-blue-400"
                    : "bg-zinc-200 text-zinc-700 dark:bg-zinc-600/20 dark:text-zinc-400"
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
          <h3 className="mb-3 text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Version history
          </h3>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50">
                  <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Version
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Content (truncated)
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Date
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-zinc-600 dark:text-zinc-400">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.map((v) => (
                  <tr
                    key={v.version}
                    className="border-b border-zinc-200 last:border-0 dark:border-zinc-800/50"
                  >
                    <td className="px-4 py-3 font-mono text-zinc-700 dark:text-zinc-300">
                      v{v.version}
                    </td>
                    <td className="max-w-md px-4 py-3">
                      <button
                        onClick={() => setVersionDetail(v)}
                        className="text-left text-zinc-600 hover:text-blue-600 hover:underline dark:text-zinc-400 dark:hover:text-blue-400"
                      >
                        {v.text.slice(0, 80)}
                        {v.text.length > 80 ? "…" : ""}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-500">
                      {new Date(v.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => onRestore(v)}
                        className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
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
