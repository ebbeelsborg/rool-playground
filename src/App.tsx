import { useEffect, useState } from "react";
import { RoolClient, RoolSpace } from "@rool-dev/sdk";
import type { RoolObject } from "@rool-dev/sdk";
import { JOB_FILTER_SYSTEM_INSTRUCTION, HARVEST_PROMPT } from "./prompt";

const SPACE_NAME = "Remote Job Harvest";

export default function App() {
  const [client, setClient] = useState<RoolClient | null>(null);
  const [space, setSpace] = useState<RoolSpace | null>(null);
  const [authState, setAuthState] = useState<"loading" | "unauthenticated" | "ready">("loading");
  const [harvesting, setHarvesting] = useState(false);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [jobs, setJobs] = useState<RoolObject[]>([]);
  const [companies, setCompanies] = useState<RoolObject[]>([]);

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

      const refresh = async () => {
        const [jobRes, companyRes] = await Promise.all([
          s.findObjects({ where: { type: "job" }, limit: 100 }),
          s.findObjects({ where: { type: "company" }, limit: 100 }),
        ]);
        if (mounted) {
          setJobs(jobRes.objects);
          setCompanies(companyRes.objects);
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
    setHarvesting(true);
    setLastMessage(null);
    try {
      const { message, objects } = await space.prompt(HARVEST_PROMPT, {
        effort: "REASONING",
      });
      setLastMessage(message);
      const [jobRes, companyRes] = await Promise.all([
        space.findObjects({ where: { type: "job" }, limit: 100 }),
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

        <div style={styles.grid}>
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Companies ({companies.length})</h2>
            <ul style={styles.list}>
              {companies.map((c) => (
                <li key={c.id} style={styles.listItem}>
                  <strong>{String(c.name ?? "Unknown")}</strong>
                  {c.careersUrl && (
                    <a
                      href={String(c.careersUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={styles.link}
                    >
                      Careers
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Jobs ({jobs.length})</h2>
            <ul style={styles.list}>
              {jobs.map((j) => (
                <li key={j.id} style={styles.jobItem}>
                  <strong>{String(j.title ?? "Unknown")}</strong>
                  <span style={styles.meta}>{String(j.companyName ?? j.level ?? "")}</span>
                  {j.url && (
                    <a
                      href={String(j.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={styles.link}
                    >
                      Apply
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    </div>
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
  title: {
    margin: "0 0 8px",
    fontSize: 24,
  },
  subtitle: {
    margin: "0 0 24px",
    color: "#a1a1aa",
    fontSize: 14,
  },
  button: {
    padding: "12px 24px",
    fontSize: 16,
    background: "#27272a",
    color: "#e4e4e7",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  primaryButton: {
    background: "#3b82f6",
    color: "white",
  },
  container: {
    maxWidth: 1200,
    margin: "0 auto",
    padding: 24,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 32,
  },
  logo: {
    margin: 0,
    fontSize: 24,
  },
  main: {},
  message: {
    background: "#18181b",
    borderRadius: 8,
    padding: 16,
    marginBottom: 24,
    fontSize: 14,
  },
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
  sectionTitle: {
    margin: "0 0 16px",
    fontSize: 18,
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  listItem: {
    padding: "12px 0",
    borderBottom: "1px solid #27272a",
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  jobItem: {
    padding: "12px 0",
    borderBottom: "1px solid #27272a",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  meta: {
    fontSize: 13,
    color: "#a1a1aa",
  },
  link: {
    color: "#3b82f6",
    fontSize: 13,
    marginTop: 4,
  },
};
