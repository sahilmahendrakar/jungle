import { useEffect, useState } from "react";
import { listParticipants, createParticipant, type Participant } from "./api";

// Dev sign-in: no real auth. Pick an existing participant (sets ?as=<id>) or create one.
function signInAs(id: string) {
  window.location.search = `?as=${id}`; // reloads; App reads ?as
}

export function SignIn() {
  const [people, setPeople] = useState<Participant[]>([]);
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState<"human" | "agent">("human");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = () =>
    listParticipants()
      .then((rows) => {
        setPeople(rows);
        setError("");
      })
      .catch((e) => setError(String((e as Error).message ?? e)));
  useEffect(() => { refresh(); }, []);

  async function create() {
    setError("");
    if (!handle.trim() || !displayName.trim()) {
      setError("handle and display name are required");
      return;
    }
    setBusy(true);
    try {
      const p = await createParticipant({
        kind, handle: handle.trim(), displayName: displayName.trim(),
        repo: kind === "agent" && repo.trim() ? repo.trim() : undefined,
      });
      if (kind === "human") {
        signInAs(p.id); // creating a human signs you straight in
      } else {
        setHandle(""); setDisplayName(""); setRepo("");
        await refresh(); // agent now appears in the list
      }
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const card: React.CSSProperties = {
    maxWidth: 420, margin: "8vh auto", background: "#fff", borderRadius: 12,
    boxShadow: "0 6px 30px rgba(0,0,0,0.12)", padding: 24,
  };
  const input: React.CSSProperties = {
    width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #ccc",
    font: "inherit", marginBottom: 8, boxSizing: "border-box",
  };

  return (
    <main data-testid="signin" style={{ fontFamily: "system-ui, sans-serif", background: "#f3f4f6", minHeight: "100vh" }}>
      <div style={card}>
        <h1 style={{ marginTop: 0 }}>🌴 Jungle</h1>
        <p style={{ color: "#666", marginTop: -8 }}>Dev sign-in — pick who you are.</p>

        {error && <div data-testid="signin-error" style={{ color: "#c00", marginBottom: 12 }}>{error}</div>}

        <div style={{ marginBottom: 16 }}>
          {people.length === 0 && <div style={{ color: "#999" }}>No participants yet — create one below.</div>}
          {people.map((p) => (
            <button
              key={p.id}
              data-testid="participant-item"
              onClick={() => signInAs(p.id)}
              style={{
                display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                padding: "8px 10px", borderRadius: 6, marginBottom: 4, border: "1px solid #e6e6e6",
                background: "#fafafa", font: "inherit",
              }}
            >
              <strong>@{p.handle}</strong> <span style={{ color: "#888" }}>· {p.display_name}</span>{" "}
              <span style={{ fontSize: 12, color: p.kind === "agent" ? "#2f6feb" : "#888" }}>
                ({p.kind}{p.repo ? ` · ${p.repo}` : ""})
              </span>
            </button>
          ))}
        </div>

        <details>
          <summary data-testid="create-toggle" style={{ cursor: "pointer", marginBottom: 8 }}>Create a participant</summary>
          <select
            data-testid="new-kind" value={kind}
            onChange={(e) => setKind(e.target.value as "human" | "agent")} style={input}
          >
            <option value="human">Human</option>
            <option value="agent">Agent</option>
          </select>
          <input data-testid="new-handle" style={input} placeholder="handle (e.g. sahil)"
            value={handle} onChange={(e) => setHandle(e.target.value)} />
          <input data-testid="new-display-name" style={input} placeholder="display name (e.g. Sahil)"
            value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          {kind === "agent" && (
            <input data-testid="new-repo" style={input} placeholder="repo (optional, owner/name)"
              value={repo} onChange={(e) => setRepo(e.target.value)} />
          )}
          {error && <div data-testid="signin-error" style={{ color: "#c00", marginBottom: 8 }}>{error}</div>}
          <button
            data-testid="create-button" onClick={create} disabled={busy}
            style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: "#2f6feb", color: "#fff", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Creating…" : kind === "human" ? "Create & sign in" : "Create agent"}
          </button>
          {kind === "agent" && <div style={{ fontSize: 12, color: "#888", marginTop: 6 }}>Agents with a repo take ~30s to provision (clones the repo).</div>}
        </details>
      </div>
    </main>
  );
}
