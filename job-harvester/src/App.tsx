import { useEffect, useState } from "react";
import { RoolClient, RoolSpace } from "@rool-dev/sdk";
import type { RoolObject } from "@rool-dev/sdk";
import {
  Briefcase,
  FileText,
  Building2,
  BarChart3,
  Star,
  Inbox,
  EyeOff,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  Ban,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { JOB_FILTER_SYSTEM_INSTRUCTION } from "./prompt";
import {
  HARVEST_KNOWLEDGE_ID,
  COMPANY_BLACKLIST_ID,
  COMPANY_WHITELIST_ID,
  HARVEST_PROMPT_CONFIG_ID,
  INITIAL_FILTER_RULES,
  DEFAULT_HARVEST_PROMPT,
} from "./constants";
import { Toaster } from "./Toaster";

const SPACE_NAME = "Remote Job Harvest";

type JobStatus = "inbox" | "saved" | "discarded";
type Bucket = "inbox" | "saved" | "discarded";
type Section = "jobs" | "prompt" | "companies" | "stats";

function getJobStatus(job: RoolObject): JobStatus {
  const s = job.status as string | undefined;
  if (s === "saved" || s === "discarded") return s;
  return "inbox";
}

function ensureArray(arr: unknown): string[] {
  if (Array.isArray(arr)) return arr.filter((x) => typeof x === "string");
  return [];
}

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

function normalizeCompany(name: string): string {
  return String(name ?? "").trim().toLowerCase();
}

export default function App() {
  const [client, setClient] = useState<RoolClient | null>(null);
  const [space, setSpace] = useState<RoolSpace | null>(null);
  const [authState, setAuthState] = useState<
    "loading" | "unauthenticated" | "ready"
  >("loading");
  const [harvesting, setHarvesting] = useState(false);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [llmPanelOpen, setLlmPanelOpen] = useState(true);
  const [jobs, setJobs] = useState<RoolObject[]>([]);
  const [companies, setCompanies] = useState<RoolObject[]>([]);
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [promptConfig, setPromptConfig] = useState<{
    currentText: string;
    currentVersion: number;
    versionHistory: { version: number; text: string; createdAt: number }[];
  } | null>(null);
  const [bucket, setBucket] = useState<Bucket>("inbox");
  const [section, setSection] = useState<Section>("jobs");
  const [discardModal, setDiscardModal] = useState<{ job: RoolObject } | null>(
    null
  );
  const [discardReason, setDiscardReason] = useState("");
  const [promptEditModal, setPromptEditModal] = useState(false);
  const [promptEditText, setPromptEditText] = useState("");
  const [promptEditVersion, setPromptEditVersion] = useState<number | null>(
    null
  );
  const [promptVersionDetail, setPromptVersionDetail] = useState<{
    version: number;
    text: string;
  } | null>(null);
  const [addWhitelistValue, setAddWhitelistValue] = useState("");
  const [addBlacklistValue, setAddBlacklistValue] = useState("");
  const [toast, setToast] = useState<{ title: string; description?: string } | null>(null);
  const [manualHarvestCount, setManualHarvestCount] = useState(0);
  const [automaticHarvestCount, setAutomaticHarvestCount] = useState(0);
  const [harvestLog, setHarvestLog] = useState<{ ts: number; msg: string }[]>([]);
  const [harvestProgress, setHarvestProgress] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    const s = localStorage.getItem("job-harvester-theme");
    return (s === "light" || s === "dark" || s === "system" ? s : "dark") as "light" | "dark" | "system";
  });

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
      const dark =
        theme === "dark" || (theme === "system" && media.matches);
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
      await s.setSystemInstruction(JOB_FILTER_SYSTEM_INSTRUCTION);

      const ensureObjects = async () => {
        const [knowledge, bl, wl, promptCfg] = await Promise.all([
          s.getObject(HARVEST_KNOWLEDGE_ID),
          s.getObject(COMPANY_BLACKLIST_ID),
          s.getObject(COMPANY_WHITELIST_ID),
          s.getObject(HARVEST_PROMPT_CONFIG_ID),
        ]);

        if (!knowledge) {
          await s.createObject({
            data: {
              id: HARVEST_KNOWLEDGE_ID,
              type: "harvestKnowledge",
              rules: INITIAL_FILTER_RULES,
              feedbackLog: "",
              visitedDomains: "{}",
              manualHarvestCount: 0,
              automaticHarvestCount: 0,
            },
          });
        }

        if (!bl) {
          await s.createObject({
            data: {
              id: COMPANY_BLACKLIST_ID,
              type: "companyBlacklist",
              companies: [],
            },
          });
        }

        if (!wl) {
          await s.createObject({
            data: {
              id: COMPANY_WHITELIST_ID,
              type: "companyWhitelist",
              companies: [],
            },
          });
        }

        if (!promptCfg) {
          await s.createObject({
            data: {
              id: HARVEST_PROMPT_CONFIG_ID,
              type: "harvestPromptConfig",
              currentText: DEFAULT_HARVEST_PROMPT,
              currentVersion: 1,
              versionHistory: [],
            },
          });
        }
      };
      await ensureObjects();

      const refresh = async () => {
        const [jobRes, companyRes, blRes, wlRes, promptRes, knowledgeRes] =
          await Promise.all([
            s.findObjects({ where: { type: "job" }, limit: 200 }),
            s.findObjects({ where: { type: "company" }, limit: 100 }),
            s.getObject(COMPANY_BLACKLIST_ID),
            s.getObject(COMPANY_WHITELIST_ID),
            s.getObject(HARVEST_PROMPT_CONFIG_ID),
            s.getObject(HARVEST_KNOWLEDGE_ID),
          ]);
        if (mounted) {
          setJobs(jobRes.objects);
          setCompanies(companyRes.objects);
          setBlacklist(ensureArray(blRes?.companies));
          setWhitelist(ensureArray(wlRes?.companies));
          setManualHarvestCount(Number(knowledgeRes?.manualHarvestCount ?? 0));
          setAutomaticHarvestCount(Number(knowledgeRes?.automaticHarvestCount ?? 0));
          const cfg = promptRes;
          if (cfg) {
            setPromptConfig({
              currentText: String(cfg.currentText ?? DEFAULT_HARVEST_PROMPT),
              currentVersion: Number(cfg.currentVersion ?? 1),
              versionHistory: ensureVersionHistory(cfg.versionHistory),
            });
          }
        }
      };
      const onObjectChange = () => {
        refresh();
      };
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
    client?.login("Job Harvester");
  };

  const handleHarvest = async () => {
    if (!space) return;
    const cfg = await space.getObject(HARVEST_PROMPT_CONFIG_ID);
    const promptText = String(cfg?.currentText ?? DEFAULT_HARVEST_PROMPT);
    setHarvesting(true);
    setLastMessage(null);
    setHarvestLog([]);
    setHarvestProgress(0);
    setLlmPanelOpen(true);

    const addLog = (msg: string) => {
      setHarvestLog((prev) => [...prev, { ts: Date.now(), msg }]);
    };
    addLog("Starting harvest (max ~1 min)…");

    const startTime = Date.now();
    const maxMs = 60_000;
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      setHarvestProgress(Math.min(100, (elapsed / maxMs) * 100));
    }, 200);

    try {
      const { message, objects } = await space.prompt(promptText, {
        effort: "REASONING",
      });
      clearInterval(progressInterval);
      setHarvestProgress(100);
      setLastMessage(message);
      addLog(`AI: ${message}`);

      const [jobRes, companyRes] = await Promise.all([
        space.findObjects({ where: { type: "job" }, limit: 200 }),
        space.findObjects({ where: { type: "company" }, limit: 100 }),
      ]);
      setJobs(jobRes.objects);
      setCompanies(companyRes.objects);

      const knowledge = await space.getObject(HARVEST_KNOWLEDGE_ID);
      const count = Number(knowledge?.manualHarvestCount ?? 0) + 1;
      await space.updateObject(HARVEST_KNOWLEDGE_ID, {
        data: { manualHarvestCount: count },
        ephemeral: true,
      });
      setManualHarvestCount(count);

      addLog(`Done: ${objects.length} updates, ${jobRes.objects.length} total jobs`);
      setToast({
        title: "Harvest complete",
        description: `Found ${objects.length} updates. ${jobRes.objects.length} total jobs.`,
      });
    } catch (err) {
      clearInterval(progressInterval);
      const errMsg = err instanceof Error ? err.message : "Harvest failed";
      setLastMessage(errMsg);
      addLog(`Error: ${errMsg}`);
      setToast({
        title: "Harvest failed",
        description: errMsg,
      });
    } finally {
      setHarvesting(false);
    }
  };

  const handleAddToList = async (
    companyName: string,
    list: "blacklist" | "whitelist"
  ) => {
    if (!space) return;
    const id =
      list === "blacklist" ? COMPANY_BLACKLIST_ID : COMPANY_WHITELIST_ID;
    const current = list === "blacklist" ? blacklist : whitelist;
    const name = normalizeCompany(companyName);
    if (!name || current.includes(name)) return;
    const otherList = list === "blacklist" ? whitelist : blacklist;
    const next = [...current, name].filter((x) => x !== "");

    if (otherList.includes(name)) {
      await space.updateObject(
        list === "blacklist" ? COMPANY_WHITELIST_ID : COMPANY_BLACKLIST_ID,
        {
          data: { companies: otherList.filter((x) => x !== name) },
          ephemeral: true,
        }
      );
    }
    await space.updateObject(id, {
      data: { companies: next },
      ephemeral: true,
    });
  };

  const handleRemoveFromList = async (
    companyName: string,
    list: "blacklist" | "whitelist"
  ) => {
    if (!space) return;
    const id =
      list === "blacklist" ? COMPANY_BLACKLIST_ID : COMPANY_WHITELIST_ID;
    const current = list === "blacklist" ? blacklist : whitelist;
    const next = current.filter((x) => x !== companyName);
    await space.updateObject(id, {
      data: { companies: next },
      ephemeral: true,
    });
  };

  const handlePromptEditOpen = () => {
    setPromptEditText(promptConfig?.currentText ?? DEFAULT_HARVEST_PROMPT);
    setPromptEditVersion(promptConfig?.currentVersion ?? 1);
    setPromptEditModal(true);
  };

  const handlePromptEditSave = async () => {
    if (!space) return;
    const cfg = await space.getObject(HARVEST_PROMPT_CONFIG_ID);
    const currentVersion = Number(cfg?.currentVersion ?? 1);
    const currentText = String(cfg?.currentText ?? DEFAULT_HARVEST_PROMPT);
    const history = ensureVersionHistory(cfg?.versionHistory ?? []);
    const newVersion = currentVersion + 1;
    const newHistory = [
      ...history,
      { version: currentVersion, text: currentText, createdAt: Date.now() },
    ];
    await space.updateObject(HARVEST_PROMPT_CONFIG_ID, {
      data: {
        currentText: promptEditText,
        currentVersion: newVersion,
        versionHistory: newHistory,
      },
      ephemeral: true,
    });
    setPromptConfig({
      currentText: promptEditText,
      currentVersion: newVersion,
      versionHistory: newHistory,
    });
    setPromptEditModal(false);
  };

  const handlePromptVersionSelect = (v: { version: number; text: string }) => {
    setPromptEditText(v.text);
    setPromptEditVersion(v.version);
    setPromptEditModal(true);
  };

  const handlePromptRestore = async (v: { version: number; text: string }) => {
    if (!space) return;
    const cfg = await space.getObject(HARVEST_PROMPT_CONFIG_ID);
    const history = ensureVersionHistory(cfg?.versionHistory ?? []);
    await space.updateObject(HARVEST_PROMPT_CONFIG_ID, {
      data: {
        currentText: v.text,
        currentVersion: v.version,
        versionHistory: history,
      },
      ephemeral: true,
    });
    setPromptConfig({
      currentText: v.text,
      currentVersion: v.version,
      versionHistory: history,
    });
  };

  const handleSave = async (job: RoolObject) => {
    if (!space) return;
    await space.updateObject(job.id, {
      data: { status: "saved" },
      ephemeral: true,
    });
    setBucket("saved");
  };

  const handleDiscardOpen = (job: RoolObject) => {
    setDiscardModal({ job });
    setDiscardReason("");
  };

  const handleDiscardConfirm = async () => {
    if (!space || !discardModal) return;
    const { job } = discardModal;
    const reason = discardReason.trim() || "No reason given";

    await space.updateObject(job.id, {
      data: { status: "discarded", discardReason: reason },
      ephemeral: true,
    });

    const knowledge = await space.getObject(HARVEST_KNOWLEDGE_ID);
    const currentLog = String(knowledge?.feedbackLog ?? "");
    const entry = `\n[Ignore] Job "${job.title}": ${reason}`;
    await space.updateObject(HARVEST_KNOWLEDGE_ID, {
      data: { feedbackLog: currentLog + entry },
      ephemeral: true,
    });

    setDiscardModal(null);
    setDiscardReason("");
    setBucket("discarded");
  };

  const inboxCount = jobs.filter((j) => getJobStatus(j) === "inbox").length;
  const savedCount = jobs.filter((j) => getJobStatus(j) === "saved").length;
  const discardedCount = jobs.filter((j) => getJobStatus(j) === "discarded").length;

  const filteredJobs = jobs.filter((j) => getJobStatus(j) === bucket);

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
          <h1 className="mb-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Job Harvester</h1>
          <p className="mb-6 text-zinc-500 dark:text-zinc-400">
            Sign in to Rool to harvest remote software engineer jobs from company
            careers pages.
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
    { id: "prompt", label: "Prompts", icon: FileText },
    { id: "companies", label: "Companies", icon: Building2 },
    { id: "stats", label: "Stats", icon: BarChart3 },
  ];

  return (
    <div className="flex min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Sidebar */}
      <aside className="flex w-64 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/80">
        <div className="border-b border-zinc-200 p-4 dark:border-zinc-800">
          <h1 className="text-lg font-semibold">Job Harvester</h1>
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
        <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
          <button
            onClick={handleHarvest}
            disabled={harvesting}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {harvesting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Harvesting…
              </>
            ) : (
              "Run Harvest"
            )}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            {section === "jobs" && "Jobs"}
            {section === "prompt" && "Prompts"}
            {section === "companies" && "Company Lists"}
            {section === "stats" && "Statistics"}
          </h2>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-700 dark:bg-zinc-800">
            <button
              onClick={() => {
                setTheme("light");
                localStorage.setItem("job-harvester-theme", "light");
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
                localStorage.setItem("job-harvester-theme", "dark");
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
                localStorage.setItem("job-harvester-theme", "system");
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

        <div className="flex flex-1 flex-col overflow-auto p-6">
          {section === "jobs" && (
            <JobsSection
              bucket={bucket}
              setBucket={setBucket}
              inboxCount={inboxCount}
              savedCount={savedCount}
              discardedCount={discardedCount}
              filteredJobs={filteredJobs}
              onSave={handleSave}
              onDiscard={handleDiscardOpen}
            />
          )}
          {section === "prompt" && (
            <PromptSection
              promptConfig={promptConfig}
              onEdit={handlePromptEditOpen}
              onVersionSelect={handlePromptVersionSelect}
              onRestore={handlePromptRestore}
              versionDetail={promptVersionDetail}
              setVersionDetail={setPromptVersionDetail}
              defaultPrompt={DEFAULT_HARVEST_PROMPT}
            />
          )}
          {section === "companies" && (
            <CompaniesSection
              whitelist={whitelist}
              blacklist={blacklist}
              addWhitelistValue={addWhitelistValue}
              setAddWhitelistValue={setAddWhitelistValue}
              addBlacklistValue={addBlacklistValue}
              setAddBlacklistValue={setAddBlacklistValue}
              onAddToList={handleAddToList}
              onRemoveFromList={handleRemoveFromList}
              companies={companies}
            />
          )}
          {section === "stats" && (
            <StatsSection
              jobs={jobs}
              companies={companies}
              whitelist={whitelist}
              blacklist={blacklist}
              manualHarvestCount={manualHarvestCount}
              automaticHarvestCount={automaticHarvestCount}
            />
          )}
        </div>

        {/* LLM Output panel */}
        <div className="border-t border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50">
          <button
            onClick={() => setLlmPanelOpen((o) => !o)}
            className="flex w-full items-center justify-between px-6 py-3 text-left text-sm text-zinc-500 hover:bg-zinc-300/50 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-200"
          >
            <span className="font-medium">
              {harvesting ? "LLM working…" : "LLM output"}
            </span>
            {llmPanelOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
          {llmPanelOpen && (
            <div className="max-h-48 overflow-auto border-t border-zinc-200 px-6 py-4 dark:border-zinc-800">
              {harvesting && (
                <div className="mb-3">
                  <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">
                    Max ~1 min • {Math.round(harvestProgress)}%
                  </p>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-300 dark:bg-zinc-700">
                    <div
                      className="h-full bg-blue-500 transition-all duration-200"
                      style={{ width: `${harvestProgress}%` }}
                    />
                  </div>
                </div>
              )}
              {harvestLog.length > 0 ? (
                <div className="space-y-1.5 text-sm">
                  {harvestLog.map((e, i) => (
                    <div
                      key={i}
                      className="flex gap-2 text-zinc-600 dark:text-zinc-400"
                    >
                      <span className="shrink-0 text-xs text-zinc-400">
                        {new Date(e.ts).toLocaleTimeString()}
                      </span>
                      <span className="whitespace-pre-wrap break-words">
                        {e.msg}
                      </span>
                    </div>
                  ))}
                </div>
              ) : lastMessage ? (
                <div className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                  <p className="whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">
                    {lastMessage}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">
                  Run a harvest to see AI output here.
                </p>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Modals */}
      {discardModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setDiscardModal(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">Ignore job</h3>
            <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
              Your reason helps the AI improve future harvests.
            </p>
            <textarea
              className="mb-4 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:placeholder-zinc-500"
              placeholder="e.g. Not actually remote, says hybrid in the text"
              value={discardReason}
              onChange={(e) => setDiscardReason(e.target.value)}
              rows={3}
            />
            <div className="flex justify-end gap-2">
              <button
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
                onClick={() => setDiscardModal(null)}
              >
                Cancel
              </button>
              <button
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
                onClick={handleDiscardConfirm}
              >
                Ignore
              </button>
            </div>
          </div>
        </div>
      )}

      {promptEditModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setPromptEditModal(false)}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Edit harvest prompt (new version {promptEditVersion ?? 1})
            </h3>
            <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
              Creating a new version keeps the previous one in history.
            </p>
            <textarea
              className="mb-4 min-h-[200px] flex-1 resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
              value={promptEditText}
              onChange={(e) => setPromptEditText(e.target.value)}
              rows={12}
            />
            <div className="flex justify-end gap-2">
              <button
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
                onClick={() => setPromptEditModal(false)}
              >
                Cancel
              </button>
              <button
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
                onClick={handlePromptEditSave}
              >
                Save as new version
              </button>
            </div>
          </div>
        </div>
      )}

      {promptVersionDetail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setPromptVersionDetail(null)}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Version {promptVersionDetail.version}
            </h3>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {promptVersionDetail.text}
            </pre>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
                onClick={() => setPromptVersionDetail(null)}
              >
                Close
              </button>
              <button
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
                onClick={() => {
                  handlePromptRestore(promptVersionDetail);
                  setPromptVersionDetail(null);
                }}
              >
                Restore
              </button>
            </div>
          </div>
        </div>
      )}

      <Toaster toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

function JobsSection({
  bucket,
  setBucket,
  inboxCount,
  savedCount,
  discardedCount,
  filteredJobs,
  onSave,
  onDiscard,
}: {
  bucket: Bucket;
  setBucket: (b: Bucket) => void;
  inboxCount: number;
  savedCount: number;
  discardedCount: number;
  filteredJobs: RoolObject[];
  onSave: (j: RoolObject) => void;
  onDiscard: (j: RoolObject) => void;
}) {
  return (
    <div className="flex gap-6">
      {/* Left pane: bucket filters */}
      <div className="flex w-52 shrink-0 flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <button
          onClick={() => setBucket("inbox")}
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            bucket === "inbox"
              ? "bg-blue-600 text-white"
              : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
          }`}
        >
          <Inbox className="h-4 w-4 shrink-0" />
          Inbox ({inboxCount})
        </button>
        <button
          onClick={() => setBucket("saved")}
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            bucket === "saved"
              ? "bg-blue-600 text-white"
              : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
          }`}
        >
          <Star className="h-4 w-4 shrink-0 fill-yellow-500 text-yellow-500" />
          Saved ({savedCount})
        </button>
        <button
          onClick={() => setBucket("discarded")}
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            bucket === "discarded"
              ? "bg-red-600/20 text-red-500 dark:text-red-400"
              : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
          }`}
        >
          <EyeOff className="h-4 w-4 shrink-0" />
          Ignored ({discardedCount})
        </button>
      </div>

      {/* Right: job list */}
      <div className="min-w-0 flex-1 space-y-4">
      <ul className="space-y-2">
        {filteredJobs.map((j) => (
          <JobCard
            key={j.id}
            job={j}
            bucket={bucket}
            onSave={onSave}
            onDiscard={onDiscard}
          />
        ))}
      </ul>
      {filteredJobs.length === 0 && (
        <p className="py-8 text-center text-zinc-500">
          No jobs in this bucket. Run a harvest or switch bucket.
        </p>
      )}
      </div>
    </div>
  );
}

function PromptSection({
  promptConfig,
  onEdit,
  onVersionSelect,
  onRestore,
  versionDetail,
  setVersionDetail,
  defaultPrompt,
}: {
  promptConfig: {
    currentText: string;
    currentVersion: number;
    versionHistory: { version: number; text: string; createdAt: number }[];
  } | null;
  onEdit: () => void;
  onVersionSelect: (v: { version: number; text: string }) => void;
  onRestore: (v: { version: number; text: string }) => void;
  versionDetail: { version: number; text: string } | null;
  setVersionDetail: (v: { version: number; text: string } | null) => void;
  defaultPrompt: string;
}) {
  const text = promptConfig?.currentText ?? defaultPrompt;
  const history = [...(promptConfig?.versionHistory ?? [])].reverse();

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <h3 className="mb-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Current prompt (v{promptConfig?.currentVersion ?? 1})
        </h3>
        <pre className="whitespace-pre-wrap break-words text-sm text-zinc-700 dark:text-zinc-300">
          {text.slice(0, 400)}
          {text.length > 400 ? "…" : ""}
        </pre>
        <button
          onClick={onEdit}
          className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Edit prompt
        </button>
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

function CompaniesSection({
  whitelist,
  blacklist,
  addWhitelistValue,
  setAddWhitelistValue,
  addBlacklistValue,
  setAddBlacklistValue,
  onAddToList,
  onRemoveFromList,
  companies,
}: {
  whitelist: string[];
  blacklist: string[];
  addWhitelistValue: string;
  setAddWhitelistValue: (v: string) => void;
  addBlacklistValue: string;
  setAddBlacklistValue: (v: string) => void;
  onAddToList: (name: string, list: "blacklist" | "whitelist") => void;
  onRemoveFromList: (name: string, list: "blacklist" | "whitelist") => void;
  companies: RoolObject[];
}) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <h3 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">
          Whitelist ({whitelist.length}) – always harvest
        </h3>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-500">
          Stored lowercase, trimmed. LLM also discovers new companies.
        </p>
        <div className="mb-3 flex gap-2">
          <input
            type="text"
            placeholder="Add company name"
            value={addWhitelistValue}
            onChange={(e) => setAddWhitelistValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = normalizeCompany(addWhitelistValue);
                if (v) onAddToList(v, "whitelist");
                setAddWhitelistValue("");
              }
            }}
            className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:placeholder-zinc-500"
          />
          <button
            onClick={() => {
              const v = normalizeCompany(addWhitelistValue);
              if (v) onAddToList(v, "whitelist");
              setAddWhitelistValue("");
            }}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            Add
          </button>
        </div>
        <ul className="space-y-1">
          {whitelist.map((name) => (
            <li
              key={name}
              className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <span className="text-sm text-zinc-800 dark:text-zinc-200">{name}</span>
              <button
                onClick={() => onRemoveFromList(name, "whitelist")}
                className="text-xs text-zinc-500 hover:text-red-500 dark:hover:text-red-400"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <h3 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">
          Blacklist ({blacklist.length}) – never harvest
        </h3>
        <p className="mb-3 text-xs text-zinc-500">
          Stored lowercase, trimmed.
        </p>
        <div className="mb-3 flex gap-2">
          <input
            type="text"
            placeholder="Add company name"
            value={addBlacklistValue}
            onChange={(e) => setAddBlacklistValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = normalizeCompany(addBlacklistValue);
                if (v) onAddToList(v, "blacklist");
                setAddBlacklistValue("");
              }
            }}
            className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:placeholder-zinc-500"
          />
          <button
            onClick={() => {
              const v = normalizeCompany(addBlacklistValue);
              if (v) onAddToList(v, "blacklist");
              setAddBlacklistValue("");
            }}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            Add
          </button>
        </div>
        <ul className="space-y-1">
          {blacklist.map((name) => (
            <li
              key={name}
              className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <span className="text-sm text-zinc-800 dark:text-zinc-200">{name}</span>
              <button
                onClick={() => onRemoveFromList(name, "blacklist")}
                className="text-xs text-zinc-500 hover:text-red-500 dark:hover:text-red-400"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>

      {companies.length > 0 && (
        <div className="md:col-span-2 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
          <h3 className="mb-3 text-sm font-medium text-zinc-600 dark:text-zinc-400">
            Discovered companies ({companies.length})
          </h3>
          <p className="mb-3 text-xs text-zinc-500">
            Quick-add to whitelist or blacklist
          </p>
          <ul className="flex flex-wrap gap-2">
            {companies.map((c) => {
              const name = String(c.name ?? "Unknown");
              const normalized = normalizeCompany(name);
              const inWhitelist = whitelist.includes(normalized);
              const inBlacklist = blacklist.includes(normalized);
              return (
                <li
                  key={c.id}
                  className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800/50"
                >
                  <span className="text-sm text-zinc-800 dark:text-zinc-200">{name}</span>
                  {inWhitelist ? (
                    <button
                      onClick={() => onRemoveFromList(normalized, "whitelist")}
                      className="text-xs text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
                    >
                      ✓ Whitelist
                    </button>
                  ) : (
                    <button
                      onClick={() => onAddToList(name, "whitelist")}
                      className="text-xs text-zinc-500 hover:text-green-600 dark:hover:text-green-400"
                    >
                      + Whitelist
                    </button>
                  )}
                  {inBlacklist ? (
                    <button
                      onClick={() => onRemoveFromList(normalized, "blacklist")}
                      className="text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                    >
                      ✓ Blacklist
                    </button>
                  ) : (
                    <button
                      onClick={() => onAddToList(name, "blacklist")}
                      className="text-xs text-zinc-500 hover:text-red-600 dark:hover:text-red-400"
                    >
                      + Blacklist
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function StatsSection({
  jobs,
  companies,
  whitelist,
  blacklist,
  manualHarvestCount,
  automaticHarvestCount,
}: {
  jobs: RoolObject[];
  companies: RoolObject[];
  whitelist: string[];
  blacklist: string[];
  manualHarvestCount: number;
  automaticHarvestCount: number;
}) {
  const inboxCount = jobs.filter((j) => getJobStatus(j) === "inbox").length;
  const savedCount = jobs.filter((j) => getJobStatus(j) === "saved").length;
  const discardedCount = jobs.filter((j) => getJobStatus(j) === "discarded").length;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Manual harvests</p>
        <p className="text-2xl font-semibold">{manualHarvestCount}</p>
      </div>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Automatic harvests</p>
        <p className="text-2xl font-semibold">{automaticHarvestCount}</p>
      </div>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Total jobs</p>
        <p className="text-2xl font-semibold">{jobs.length}</p>
      </div>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Inbox</p>
        <p className="text-2xl font-semibold text-blue-400">{inboxCount}</p>
      </div>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Saved</p>
        <p className="text-2xl font-semibold text-yellow-500">{savedCount}</p>
      </div>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Ignored</p>
        <p className="text-2xl font-semibold text-red-400">{discardedCount}</p>
      </div>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Companies</p>
        <p className="text-2xl font-semibold">{companies.length}</p>
      </div>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Whitelisted companies</p>
        <p className="text-2xl font-semibold">{whitelist.length}</p>
      </div>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Blacklisted companies</p>
        <p className="text-2xl font-semibold">{blacklist.length}</p>
      </div>
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

function JobCard({
  job,
  bucket,
  onSave,
  onDiscard,
}: {
  job: RoolObject;
  bucket: Bucket;
  onSave: (j: RoolObject) => void;
  onDiscard: (j: RoolObject) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  const tags = getJobTags(job);

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50 dark:shadow-none">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <strong className="text-zinc-900 dark:text-zinc-200">
              {String(job.title ?? "Unknown")}
            </strong>
            {bucket === "discarded" && (
              <span className="shrink-0 rounded bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400">
                Ignored
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            {String(job.companyName ?? job.level ?? "")}
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
        <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="rounded p-2 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            aria-label="Menu"
          >
            ⋮
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 top-full z-20 mt-1 min-w-[140px] rounded-lg border border-zinc-200 bg-white py-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-800">
                {bucket !== "saved" && (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
                    onClick={() => {
                      onSave(job);
                      setMenuOpen(false);
                    }}
                  >
                    <Star className="h-4 w-4" />
                    Save
                  </button>
                )}
                {bucket !== "discarded" && (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
                    onClick={() => {
                      onDiscard(job);
                      setMenuOpen(false);
                    }}
                  >
                    <Ban className="h-4 w-4 text-red-400" />
                    Ignore
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {bucket === "discarded" && job.discardReason && (
        <p className="text-sm italic text-zinc-500">
          Reason: {String(job.discardReason)}
        </p>
      )}
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
