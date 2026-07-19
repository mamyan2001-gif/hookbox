import { useCallback, useEffect, useState } from "react";

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new Error("Cannot reach API");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
  return data;
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso || "—";
  }
}

function verifiedLabel(verified) {
  if (verified === true) return "verified";
  if (verified === false) return "invalid";
  return "none";
}

function CreatePanel({ onCreated }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleCreate(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api("/api/inboxes", { method: "POST", body: "{}" });
      onCreated(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="composer" onSubmit={handleCreate}>
      <p className="lead">Capture webhooks. Inspect. Replay.</p>
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create inbox"}
      </button>
      {error && <div className="alert alert--error">{error}</div>}
    </form>
  );
}

function persistInbox(data) {
  try {
    if (!data) {
      sessionStorage.removeItem("hookbox.inbox");
      return;
    }
    sessionStorage.setItem("hookbox.inbox", JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

function InboxPanel({ inbox, onReset, onInboxUpdate }) {
  const [events, setEvents] = useState([]);
  const [meta, setMeta] = useState(inbox);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [copied, setCopied] = useState(false);
  const [secretShown, setSecretShown] = useState(Boolean(inbox.hmacSecret));
  const [expanded, setExpanded] = useState({});
  const [replayUrl, setReplayUrl] = useState({});
  const [replayBusy, setReplayBusy] = useState({});
  const [replayResult, setReplayResult] = useState({});
  const [loading, setLoading] = useState(true);

  const captureLink =
    typeof window !== "undefined"
      ? `${window.location.origin}${inbox.captureUrl}`
      : inbox.publicUrl || inbox.captureUrl;

  const refresh = useCallback(async () => {
    const [nextMeta, nextEvents] = await Promise.all([
      api(`/api/inboxes/${inbox.id}`),
      api(`/api/inboxes/${inbox.id}/events`),
    ]);
    setMeta(nextMeta);
    setEvents(nextEvents.events || []);
  }, [inbox.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await refresh();
        if (!cancelled) setError("");
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh]);

  async function copyCapture() {
    try {
      await navigator.clipboard.writeText(captureLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const input = document.querySelector(".result__row input");
      if (input) {
        input.focus();
        input.select();
      }
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this inbox and all events?")) return;
    setError("");
    try {
      await api(`/api/inboxes/${inbox.id}`, { method: "DELETE" });
      onReset();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleReplay(eventId) {
    const targetUrl = (replayUrl[eventId] || "").trim();
    if (!targetUrl) {
      setReplayResult((prev) => ({ ...prev, [eventId]: { error: "Enter a target URL" } }));
      return;
    }
    setReplayBusy((prev) => ({ ...prev, [eventId]: true }));
    setReplayResult((prev) => ({ ...prev, [eventId]: null }));
    try {
      const data = await api(`/api/inboxes/${inbox.id}/events/${eventId}/replay`, {
        method: "POST",
        body: JSON.stringify({ targetUrl }),
      });
      setReplayResult((prev) => ({ ...prev, [eventId]: data }));
      setInfo(`Replayed → ${data.status}`);
    } catch (err) {
      setReplayResult((prev) => ({ ...prev, [eventId]: { error: err.message } }));
    } finally {
      setReplayBusy((prev) => ({ ...prev, [eventId]: false }));
    }
  }

  function toggleExpand(id) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div className="inbox">
      <div className="result">
        <div className="result__label">Capture URL</div>
        <div className="result__row">
          <input readOnly value={captureLink} onFocus={(e) => e.target.select()} aria-label="Capture URL" />
          <button type="button" className="btn btn-primary" onClick={copyCapture}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="result__meta">
          {meta.eventCount ?? events.length} events · created {formatTime(meta.createdAt)}
          {meta.hasHmacSecret ? " · HMAC ready" : ""}
        </p>
      </div>

      {secretShown && inbox.hmacSecret && (
        <div className="secret">
          <div className="result__label">HMAC secret (shown once)</div>
          <code className="secret__value">{inbox.hmacSecret}</code>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setSecretShown(false);
              if (typeof onInboxUpdate === "function") {
                const { hmacSecret: _drop, ...rest } = inbox;
                onInboxUpdate(rest);
              }
            }}
          >
            Hide secret
          </button>
        </div>
      )}

      <div className="actions">
        <button type="button" className="btn btn-ghost" onClick={() => refresh().catch((e) => setError(e.message))}>
          Refresh
        </button>
        <button type="button" className="btn btn-ghost" onClick={handleDelete}>
          Delete inbox
        </button>
        <button type="button" className="btn btn-ghost" onClick={onReset}>
          New
        </button>
      </div>

      {info && <div className="alert alert--ok">{info}</div>}
      {error && <div className="alert alert--error">{error}</div>}

      <section className="events">
        <h2 className="events__title">Events</h2>
        {loading && events.length === 0 && <p className="status">Loading…</p>}
        {!loading && events.length === 0 && (
          <p className="status">Waiting for requests at the capture URL…</p>
        )}
        <ul className="events__list">
          {events.map((ev) => {
            const open = Boolean(expanded[ev.id]);
            return (
              <li key={ev.id} className="event">
                <button type="button" className="event__head" onClick={() => toggleExpand(ev.id)}>
                  <span className="event__method">{ev.method}</span>
                  <span className="event__time">{formatTime(ev.receivedAt)}</span>
                  <span className={`event__badge event__badge--${verifiedLabel(ev.verified)}`}>
                    {verifiedLabel(ev.verified)}
                  </span>
                  <span className="event__chevron">{open ? "−" : "+"}</span>
                </button>
                {open && (
                  <div className="event__body">
                    <div className="event__meta">
                      <span>{ev.contentType || "no content-type"}</span>
                      <span>{ev.size ?? (ev.body || "").length} B</span>
                      {ev.query && Object.keys(ev.query).length > 0 && (
                        <span>?{new URLSearchParams(ev.query).toString()}</span>
                      )}
                    </div>
                    <details className="event__block">
                      <summary>Headers</summary>
                      <pre>{JSON.stringify(ev.headers, null, 2)}</pre>
                    </details>
                    <details className="event__block" open>
                      <summary>Body</summary>
                      <pre>{ev.body || "(empty)"}</pre>
                    </details>
                    <div className="replay">
                      <label htmlFor={`replay-${ev.id}`}>Replay to</label>
                      <div className="replay__row">
                        <input
                          id={`replay-${ev.id}`}
                          type="url"
                          placeholder="https://example.com/webhook"
                          value={replayUrl[ev.id] || ""}
                          onChange={(e) =>
                            setReplayUrl((prev) => ({ ...prev, [ev.id]: e.target.value }))
                          }
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={replayBusy[ev.id]}
                          onClick={() => handleReplay(ev.id)}
                        >
                          {replayBusy[ev.id] ? "…" : "Replay"}
                        </button>
                      </div>
                      {replayResult[ev.id]?.error && (
                        <div className="alert alert--error">{replayResult[ev.id].error}</div>
                      )}
                      {replayResult[ev.id]?.status != null && (
                        <div className="alert alert--ok">
                          Status {replayResult[ev.id].status} {replayResult[ev.id].statusText}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

export default function App() {
  const [inbox, setInbox] = useState(() => {
    try {
      const raw = sessionStorage.getItem("hookbox.inbox");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  function handleCreated(data) {
    setInbox(data);
    persistInbox(data);
  }

  function handleInboxUpdate(next) {
    setInbox(next);
    persistInbox(next);
  }

  function handleReset() {
    setInbox(null);
    persistInbox(null);
  }

  return (
    <div className="app">
      <header className="brand">
        <div className="brand__name">Hookbox</div>
      </header>

      {inbox ? (
        <InboxPanel
          inbox={inbox}
          onReset={handleReset}
          onInboxUpdate={handleInboxUpdate}
        />
      ) : (
        <CreatePanel onCreated={handleCreated} />
      )}
    </div>
  );
}
