import { useEffect, useState } from "react";
import { RoolClient, RoolSpace } from "@rool-dev/sdk";
import type { RoolObject } from "@rool-dev/sdk";
import { JOB_FILTER_SYSTEM_INSTRUCTION } from "./prompt";
import {
  HARVEST_KNOWLEDGE_ID,
  COMPANY_BLACKLIST_ID,
  COMPANY_WHITELIST_ID,
  HARVEST_PROMPT_CONFIG_ID,
  INITIAL_FILTER_RULES,
  DEFAULT_HARVEST_PROMPT,
} from "./constants";

const SPACE_NAME = "Remote Job Harvest";

type JobStatus = "inbox" | "saved" | "discarded";
type Bucket = "inbox" | "saved" | "discarded";

function getJobStatus(job: RoolObject): JobStatus {
  const s = job.status as string | undefined;
  if (s === "saved" || s === "discarded") return s;
  return "inbox";
}

function ensureArray(arr: unknown): string[] {
  if (Array.isArray(arr)) return arr.filter((x) => typeof x === "string");
  return [];
}

function ensureVersionHistory(v: unknown): { version: number; text: string; createdAt: number }[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is { version: number; text: string; createdAt: number } =>
      typeof x === "object" && x !== null && typeof (x as { version?: unknown }).version === "number"
  );
}

export default function App() {
  const [client, setClient] = useState<RoolClient | null>(null);
  const [space, setSpace] = useState<RoolSpace | null>(null);
  const [authState, setAuthState] = useState<"loading" | "unauthenticated" | "ready">("loading");
  const [harvesting, setHarvesting] = useState(false);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
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
  const [discardModal, setDiscardModal] = useState<{ job: RoolObject } | null>(null);
  const [discardReason, setDiscardReason] = useState("");
  const [promptEditModal, setPromptEditModal] = useState(false);
  const [promptEditText, setPromptEditText] = useState("");
  const [promptEditVersion, setPromptEditVersion] = useState<number | null>(null);
  const [addWhitelistValue, setAddWhitelistValue] = useState("");
  const [addBlacklistValue, setAddBlacklistValue] = useState("");

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
        const [jobRes, companyRes, blRes, wlRes, promptRes] = await Promise.all([
          s.findObjects({ where: { type: "job" }, limit: 200 }),
          s.findObjects({ where: { type: "company" }, limit: 100 }),
          s.getObject(COMPANY_BLACKLIST_ID),
          s.getObject(COMPANY_WHITELIST_ID),
          s.getObject(HARVEST_PROMPT_CONFIG_ID),
        ]);
        if (mounted) {
          setJobs(jobRes.objects);
          setCompanies(companyRes.objects);
          setBlacklist(ensureArray(blRes?.companies));
          setWhitelist(ensureArray(wlRes?.companies));
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
    try {
      const { message, objects } = await space.prompt(promptText, {
        effort: "REASONING",
      });
      setLastMessage(message);
      const [jobRes, companyRes] = await Promise.all([
        space.findObjects({ where: { type: "job" }, limit: 200 }),
        space.findObjects({ where: { type: "company" }, limit: 100 }),
      ]);
      setJobs(jobRes.objects);
      setCompanies(companyRes.objects);
    } catch (err) {
      setLastMessage(err instanceof Error ? err.message : "Harvest failed");
    } finally {
      setHarvesting(false);
    }
  };

  const handleAddToList = async (companyName: string, list: "blacklist" | "whitelist") => {
    if (!space) return;
    const id = list === "blacklist" ? COMPANY_BLACKLIST_ID : COMPANY_WHITELIST_ID;
    const current = list === "blacklist" ? blacklist : whitelist;
    const name = String(companyName ?? "").trim();
    if (!name || current.includes(name)) return;
    const otherList = list === "blacklist" ? whitelist : blacklist;
    const next = [...current, name].filter((x) => x !== "");

    if (otherList.includes(name)) {
      await space.updateObject(list === "blacklist" ? COMPANY_WHITELIST_ID : COMPANY_BLACKLIST_ID, {
        data: { companies: otherList.filter((x) => x !== name) },
        ephemeral: true,
      });
    }
    await space.updateObject(id, {
      data: { companies: next },
      ephemeral: true,
    });
  };

  const handleRemoveFromList = async (companyName: string, list: "blacklist" | "whitelist") => {
    if (!space) return;
    const id = list === "blacklist" ? COMPANY_BLACKLIST_ID : COMPANY_WHITELIST_ID;
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
    const history = ensureVersionHistory(cfg?.versionHistory ?? []);
    const newVersion = currentVersion + 1;
    const newHistory = [
      ...history,
      { version: newVersion, text: promptEditText, createdAt: Date.now() },
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
    await space.updateObject(job.id, { data: { status: "saved" }, ephemeral: true });
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
    const entry = `\n[Discard] Job "${job.title}": ${reason}`;
    await space.updateObject(HARVEST_KNOWLEDGE_ID, {
      data: { feedbackLog: currentLog + entry },
      ephemeral: true,
    });

    setDiscardModal(null);
    setDiscardReason("");
  };

  const filteredJobs = jobs.filter((j) => getJobStatus(j) === bucket);
  const inboxCount = jobs.filter((j) => getJobStatus(j) === "inbox").length;
  const savedCount = jobs.filter((j) => getJobStatus(j) === "saved").length;
  const discardedCount = jobs.filter((j) => getJobStatus(j) === "discarded").length;

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
          <h1 style={styles.title}>Job Harvester</h1>
          <p style={styles.subtitle}>
            Sign in to Rool to harvest remote software engineer jobs from company careers pages.
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
        <h1 style={styles.logo}>Job Harvester</h1>
        <button
          style={{ ...styles.button, ...styles.primaryButton }}
          onClick={handleHarvest}
          disabled={harvesting}
        >
          {harvesting ? "Harvesting…" : "Run Harvest"}
        </button>
      </header>

      <main style={styles.main}>
        {lastMessage && (
          <div style={styles.message}>
            <strong>AI:</strong> {lastMessage}
          </div>
        )}

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Harvest Prompt (v{promptConfig?.currentVersion ?? 1})</h2>
          <pre style={styles.promptPreview}>
            {(promptConfig?.currentText ?? DEFAULT_HARVEST_PROMPT).slice(0, 300)}
            {(promptConfig?.currentText ?? "").length > 300 ? "…" : ""}
          </pre>
          <button style={styles.smallButton} onClick={handlePromptEditOpen}>
            Edit prompt
          </button>
          {promptConfig && promptConfig.versionHistory.length > 0 && (
            <div style={styles.versionHistory}>
              <strong>Version history:</strong>
              {[...promptConfig.versionHistory].reverse().map((v) => (
                <div key={v.version} style={styles.versionRow}>
                  <button
                    style={styles.versionItem}
                    onClick={() => handlePromptVersionSelect(v)}
                  >
                    v{v.version} – {new Date(v.createdAt).toLocaleString()}
                  </button>
                  <button
                    style={styles.smallButton}
                    onClick={() => handlePromptRestore(v)}
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <div style={styles.grid}>
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Whitelist ({whitelist.length})</h2>
            <p style={styles.listHint}>
              Always harvest from these. LLM also discovers new companies to expand the pool.
            </p>
            <div style={styles.addRow}>
              <input
                style={styles.addInput}
                placeholder="Add company name"
                value={addWhitelistValue}
                onChange={(e) => setAddWhitelistValue(e.target.value)}
              />
              <button
                style={styles.smallButton}
                onClick={() => {
                  const v = addWhitelistValue.trim();
                  if (v) handleAddToList(v, "whitelist");
                  setAddWhitelistValue("");
                }}
              >
                Add
              </button>
            </div>
            <ul style={styles.list}>
              {whitelist.map((name) => (
                <li key={name} style={styles.listItem}>
                  <span>{name}</span>
                  <button
                    style={styles.removeBtn}
                    onClick={() => handleRemoveFromList(name, "whitelist")}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Blacklist ({blacklist.length})</h2>
            <p style={styles.listHint}>Never harvest from these companies</p>
            <div style={styles.addRow}>
              <input
                style={styles.addInput}
                placeholder="Add company name"
                value={addBlacklistValue}
                onChange={(e) => setAddBlacklistValue(e.target.value)}
              />
              <button
                style={styles.smallButton}
                onClick={() => {
                  const v = addBlacklistValue.trim();
                  if (v) handleAddToList(v, "blacklist");
                  setAddBlacklistValue("");
                }}
              >
                Add
              </button>
            </div>
            <ul style={styles.list}>
              {blacklist.map((name) => (
                <li key={name} style={styles.listItem}>
                  <span>{name}</span>
                  <button
                    style={styles.removeBtn}
                    onClick={() => handleRemoveFromList(name, "blacklist")}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div style={styles.tabs}>
          <button
            style={{
              ...styles.tab,
              ...(bucket === "inbox" ? styles.tabActive : {}),
            }}
            onClick={() => setBucket("inbox")}
          >
            Inbox ({inboxCount})
          </button>
          <button
            style={{
              ...styles.tab,
              ...(bucket === "saved" ? styles.tabActive : {}),
            }}
            onClick={() => setBucket("saved")}
          >
            ★ Saved ({savedCount})
          </button>
          <button
            style={{
              ...styles.tab,
              ...(bucket === "discarded" ? styles.tabActive : {}),
            }}
            onClick={() => setBucket("discarded")}
          >
            Discarded ({discardedCount})
          </button>
        </div>

        <div style={styles.grid}>
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Companies ({companies.length})</h2>
            <ul style={styles.list}>
              {companies.map((c) => (
                <CompanyCard
                  key={c.id}
                  company={c}
                  blacklist={blacklist}
                  whitelist={whitelist}
                  onAddToBlacklist={() => handleAddToList(String(c.name ?? ""), "blacklist")}
                  onAddToWhitelist={() => handleAddToList(String(c.name ?? ""), "whitelist")}
                  onRemoveFromBlacklist={() => handleRemoveFromList(String(c.name ?? ""), "blacklist")}
                  onRemoveFromWhitelist={() => handleRemoveFromList(String(c.name ?? ""), "whitelist")}
                />
              ))}
            </ul>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>
              {bucket === "inbox" ? "Inbox" : bucket === "saved" ? "Saved" : "Discarded"} ({filteredJobs.length})
            </h2>
            <ul style={styles.list}>
              {filteredJobs.map((j) => (
                <JobCard
                  key={j.id}
                  job={j}
                  bucket={bucket}
                  onSave={handleSave}
                  onDiscard={handleDiscardOpen}
                />
              ))}
            </ul>
          </section>
        </div>
      </main>

      {discardModal && (
        <div style={styles.modalOverlay} onClick={() => setDiscardModal(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={styles.modalTitle}>Discard job</h3>
            <p style={styles.modalSubtitle}>
              Your reason helps the AI improve future harvests.
            </p>
            <textarea
              style={styles.textarea}
              placeholder="e.g. Not actually remote, says hybrid in the text"
              value={discardReason}
              onChange={(e) => setDiscardReason(e.target.value)}
              rows={3}
            />
            <div style={styles.modalActions}>
              <button style={styles.button} onClick={() => setDiscardModal(null)}>
                Cancel
              </button>
              <button
                style={{ ...styles.button, ...styles.primaryButton }}
                onClick={handleDiscardConfirm}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}

      {promptEditModal && (
        <div style={styles.modalOverlay} onClick={() => setPromptEditModal(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={styles.modalTitle}>
              Edit harvest prompt (new version {promptEditVersion ?? 1})
            </h3>
            <p style={styles.modalSubtitle}>
              Creating a new version keeps the previous one in history.
            </p>
            <textarea
              style={{ ...styles.textarea, minHeight: 200 }}
              value={promptEditText}
              onChange={(e) => setPromptEditText(e.target.value)}
              rows={12}
            />
            <div style={styles.modalActions}>
              <button style={styles.button} onClick={() => setPromptEditModal(false)}>
                Cancel
              </button>
              <button
                style={{ ...styles.button, ...styles.primaryButton }}
                onClick={handlePromptEditSave}
              >
                Save as new version
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CompanyCard({
  company,
  blacklist,
  whitelist,
  onAddToBlacklist,
  onAddToWhitelist,
  onRemoveFromBlacklist,
  onRemoveFromWhitelist,
}: {
  company: RoolObject;
  blacklist: string[];
  whitelist: string[];
  onAddToBlacklist: () => void;
  onAddToWhitelist: () => void;
  onRemoveFromBlacklist: () => void;
  onRemoveFromWhitelist: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const name = String(company.name ?? "Unknown");
  const isBlacklisted = blacklist.includes(name);
  const isWhitelisted = whitelist.includes(name);

  return (
    <li style={styles.listItem}>
      <div style={styles.jobCardHeader}>
        <div>
          <strong>{name}</strong>
          {company.careersUrl && (
            <a
              href={String(company.careersUrl)}
              target="_blank"
              rel="noopener noreferrer"
              style={styles.link}
            >
              Careers
            </a>
          )}
        </div>
        <div style={styles.menuContainer}>
          <button
            style={styles.menuButton}
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Menu"
          >
            ⋮
          </button>
          {menuOpen && (
            <>
              <div style={styles.menuBackdrop} onClick={() => setMenuOpen(false)} />
              <div style={styles.menuDropdown}>
                {isWhitelisted ? (
                  <button style={styles.menuItem} onClick={() => { onRemoveFromWhitelist(); setMenuOpen(false); }}>
                    Remove from whitelist
                  </button>
                ) : (
                  <button style={styles.menuItem} onClick={() => { onAddToWhitelist(); setMenuOpen(false); }}>
                    Add to whitelist
                  </button>
                )}
                {isBlacklisted ? (
                  <button style={styles.menuItem} onClick={() => { onRemoveFromBlacklist(); setMenuOpen(false); }}>
                    Remove from blacklist
                  </button>
                ) : (
                  <button style={styles.menuItem} onClick={() => { onAddToBlacklist(); setMenuOpen(false); }}>
                    Add to blacklist
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </li>
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
  onSave: (job: RoolObject) => void;
  onDiscard: (job: RoolObject) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <li style={styles.jobItem}>
      <div style={styles.jobCardHeader}>
        <div style={styles.jobCardContent}>
          <strong>{String(job.title ?? "Unknown")}</strong>
          <span style={styles.meta}>{String(job.companyName ?? job.level ?? "")}</span>
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
        </div>
        <div style={styles.menuContainer}>
          <button
            style={styles.menuButton}
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Menu"
          >
            ⋮
          </button>
          {menuOpen && (
            <>
              <div
                style={styles.menuBackdrop}
                onClick={() => setMenuOpen(false)}
              />
              <div style={styles.menuDropdown}>
                {bucket !== "saved" && (
                  <button
                    style={styles.menuItem}
                    onClick={() => {
                      onSave(job);
                      setMenuOpen(false);
                    }}
                  >
                    ★ Save
                  </button>
                )}
                {bucket !== "discarded" && (
                  <button
                    style={styles.menuItem}
                    onClick={() => {
                      onDiscard(job);
                      setMenuOpen(false);
                    }}
                  >
                    Discard
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {bucket === "discarded" && job.discardReason && (
        <div style={styles.discardReason}>
          <em>Reason: {String(job.discardReason)}</em>
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
  smallButton: {
    padding: "6px 12px",
    fontSize: 13,
    background: "#27272a",
    color: "#e4e4e7",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    marginTop: 8,
  },
  primaryButton: { background: "#3b82f6", color: "white" },
  addRow: { display: "flex", gap: 8, marginBottom: 12 },
  addInput: {
    flex: 1,
    padding: "8px 12px",
    fontSize: 14,
    background: "#27272a",
    color: "#e4e4e7",
    border: "1px solid #3f3f46",
    borderRadius: 6,
  },
  removeBtn: {
    padding: "2px 8px",
    fontSize: 12,
    background: "transparent",
    color: "#71717a",
    border: "1px solid #3f3f46",
    borderRadius: 4,
    cursor: "pointer",
  },
  container: { maxWidth: 1200, margin: "0 auto", padding: 24 },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 32,
  },
  logo: { margin: 0, fontSize: 24 },
  main: {},
  message: {
    background: "#18181b",
    borderRadius: 8,
    padding: 16,
    marginBottom: 24,
    fontSize: 14,
  },
  promptPreview: {
    background: "#27272a",
    padding: 12,
    borderRadius: 8,
    fontSize: 12,
    color: "#a1a1aa",
    whiteSpace: "pre-wrap",
    overflow: "hidden",
  },
  versionHistory: {
    marginTop: 12,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  versionRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  versionItem: {
    padding: "4px 8px",
    fontSize: 12,
    background: "transparent",
    color: "#a1a1aa",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
  },
  listHint: { fontSize: 12, color: "#71717a", margin: "0 0 8px" },
  tabs: {
    display: "flex",
    gap: 8,
    marginBottom: 24,
  },
  tab: {
    padding: "8px 16px",
    fontSize: 14,
    background: "#27272a",
    color: "#a1a1aa",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  tabActive: { background: "#3b82f6", color: "white" },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 24,
  },
  section: {
    background: "#18181b",
    borderRadius: 12,
    padding: 20,
  },
  sectionTitle: { margin: "0 0 16px", fontSize: 18 },
  list: { margin: 0, padding: 0, listStyle: "none" },
  listItem: {
    padding: "12px 0",
    borderBottom: "1px solid #27272a",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  jobItem: {
    padding: "12px 0",
    borderBottom: "1px solid #27272a",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  jobCardHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  jobCardContent: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    flex: 1,
  },
  meta: { fontSize: 13, color: "#a1a1aa" },
  link: { color: "#3b82f6", fontSize: 13, marginTop: 4 },
  discardReason: { fontSize: 12, color: "#71717a", marginTop: 4 },
  menuContainer: { position: "relative" },
  menuButton: {
    padding: "4px 8px",
    fontSize: 18,
    background: "transparent",
    color: "#a1a1aa",
    border: "none",
    cursor: "pointer",
    lineHeight: 1,
  },
  menuBackdrop: { position: "fixed", inset: 0, zIndex: 10 },
  menuDropdown: {
    position: "absolute",
    top: "100%",
    right: 0,
    marginTop: 4,
    background: "#27272a",
    borderRadius: 8,
    padding: 4,
    minWidth: 120,
    zIndex: 20,
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
  },
  menuItem: {
    display: "block",
    width: "100%",
    padding: "8px 12px",
    textAlign: "left",
    background: "none",
    border: "none",
    color: "#e4e4e7",
    fontSize: 14,
    cursor: "pointer",
    borderRadius: 4,
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  },
  modal: {
    background: "#18181b",
    borderRadius: 12,
    padding: 24,
    maxWidth: 500,
    width: "90%",
  },
  modalTitle: { margin: "0 0 8px", fontSize: 18 },
  modalSubtitle: { margin: "0 0 16px", fontSize: 13, color: "#a1a1aa" },
  textarea: {
    width: "100%",
    padding: 12,
    fontSize: 14,
    background: "#27272a",
    color: "#e4e4e7",
    border: "1px solid #3f3f46",
    borderRadius: 8,
    resize: "vertical",
    marginBottom: 16,
  },
  modalActions: {
    display: "flex",
    gap: 12,
    justifyContent: "flex-end",
  },
};
