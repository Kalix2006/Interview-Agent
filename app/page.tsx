"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

const RATE_LIMIT_MS = 6500;

type Candidate = {
  member: {
    id: string;
    name: string;
    jobRole: string;
    yearsExperience: number;
    education?: string;
  };
  missions: { day: number; title: string; passed: boolean; skipped?: boolean }[];
};

type ChatRole = "interviewer" | "candidate";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
};

type TurnResponse = {
  reply: string;
  done: boolean;
};

type Score = "low" | "medium" | "high";

type Report = {
  topics: { day: number; title: string; score: Score; rationale: string }[];
  gaps: string[];
  next: string[];
};

function isReport(value: unknown): value is Report {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.topics) && Array.isArray(v.gaps) && Array.isArray(v.next);
}

function isCandidate(value: unknown): value is Candidate {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.member === "object" &&
    v.member !== null &&
    typeof (v.member as Record<string, unknown>).id === "string" &&
    Array.isArray(v.missions)
  );
}

export default function Home() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [stage, setStage] = useState<"load" | "select" | "interview">("load");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  const lastTurnAt = useRef<number | null>(null);
  const idCounter = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/candidates")
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.error ?? "Failed to load candidates.");
        }
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data?.candidates) ? data.candidates.filter(isCandidate) : [];
        setCandidates(list);
        setStage("select");
      })
      .catch((err) => {
        if (cancelled) return;
        setCandidatesError(err instanceof Error ? err.message : String(err));
        setStage("select");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, reportLoading]);

  useEffect(() => {
    if (stage === "interview" && !busy && !reportLoading) {
      textareaRef.current?.focus();
    }
  }, [stage, busy, reportLoading]);

  function nextId(): string {
    idCounter.current += 1;
    return `m${idCounter.current}`;
  }

  function toHistory(list: ChatMessage[]) {
    return list.map((m) => ({ role: m.role, content: m.content }));
  }

  async function throttle() {
    const now = Date.now();
    if (lastTurnAt.current !== null) {
      const remaining = RATE_LIMIT_MS - (now - lastTurnAt.current);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
    }
    lastTurnAt.current = Date.now();
  }

  async function runTurn(current: ChatMessage[]): Promise<TurnResponse> {
    await throttle();
    const res = await fetch("/api/interview/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId: selectedId, history: toHistory(current) }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error ?? "The interview service could not process that turn.");
    }
    if (typeof data?.reply !== "string" || typeof data?.done !== "boolean") {
      throw new Error("The interview service returned an unexpected response.");
    }
    return { reply: data.reply, done: data.done };
  }

  async function fetchReport(current: ChatMessage[]) {
    setReportLoading(true);
    setError(null);
    try {
      await throttle();
      const res = await fetch("/api/interview/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: toHistory(current) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? "Could not generate feedback.");
      }
      if (!isReport(data)) {
        throw new Error("Feedback service returned an unexpected response.");
      }
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReportLoading(false);
    }
  }

  async function startInterview() {
    if (!selectedId) {
      setError("Choose a candidate to start the interview.");
      return;
    }
    setError(null);
    setMessages([]);
    setReport(null);
    setStage("interview");
    setBusy(true);
    try {
      const turn = await runTurn([]);
      setMessages([{ id: nextId(), role: "interviewer", content: turn.reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("select");
    } finally {
      setBusy(false);
    }
  }

  async function sendAnswer() {
    const answer = input.trim();
    if (!answer || busy) return;
    setError(null);
    setInput("");
    const next = [...messages, { id: nextId(), role: "candidate" as ChatRole, content: answer }];
    setMessages(next);
    setBusy(true);
    try {
      const turn = await runTurn(next);
      const updated = [...next, { id: nextId(), role: "interviewer" as ChatRole, content: turn.reply }];
      setMessages(updated);
      if (turn.done) {
        await fetchReport(updated);
      }
    } catch (err) {
      setMessages(next.filter((m) => m.id !== next[next.length - 1].id));
      setInput(answer);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function finishInterview() {
    if (busy || reportLoading) return;
    setError(null);
    await fetchReport(messages);
  }

  function resetInterview() {
    setMessages([]);
    setReport(null);
    setError(null);
    setInput("");
    setStage("select");
  }

  function onComposerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendAnswer();
  }

  const selected = candidates.find((c) => c.member.id === selectedId) ?? null;

  const weakAreas = useMemo(
    () => (selected ? selected.missions.filter((m) => m.passed === false || m.skipped === true) : []),
    [selected]
  );

  const questionsAsked = useMemo(
    () => messages.filter((m) => m.role === "interviewer").length,
    [messages]
  );

  const daysCovered = useMemo(() => {
    const days = new Set<number>();
    for (const m of messages) {
      if (m.role !== "interviewer") continue;
      const match = /\[D:(\d+)\]/i.exec(m.content);
      if (match) days.add(Number(match[1]));
    }
    return days.size;
  }, [messages]);

  function splitDayTag(content: string): { day: string | null; text: string } {
    const match = /^\[D:(\d+)\]\s*/i.exec(content);
    if (!match) return { day: null, text: content };
    return { day: match[1], text: content.slice(match[0].length) };
  }

  return (
    <main className="page">
      <header className="masthead">
        <h1>Interview Agent</h1>
        <p>AI-powered technical interview practice with per-topic feedback.</p>
      </header>

      {stage === "load" && (
        <section className="card" aria-label="Loading candidates">
          <div className="loading-row">
            <span className="spinner" aria-hidden="true" />
            <span>Loading candidates…</span>
          </div>
        </section>
      )}

      {stage === "select" && (
        <section className="card" aria-label="Candidate selection">
          <h2>Choose a candidate</h2>
          <div className="selector-grid">
            <div className="field">
              <label htmlFor="candidate-select">Candidate</label>
              <select
                id="candidate-select"
                className="select"
                value={selectedId}
                onChange={(event) => {
                  setSelectedId(event.target.value);
                  setError(null);
                }}
              >
                <option value="">Select a candidate…</option>
                {candidates.map((candidate) => (
                  <option key={candidate.member.id} value={candidate.member.id}>
                    {candidate.member.name} — {candidate.member.jobRole} ({candidate.member.yearsExperience} yrs)
                  </option>
                ))}
              </select>
            </div>
            {candidatesError && (
              <p className="status status-error" role="alert">
                {candidatesError}
              </p>
            )}
            {selected && (
              <div className="candidate-summary">
                <h3>Interview focus</h3>
                {weakAreas.length > 0 ? (
                  <ul>
                    {weakAreas.map((mission) => (
                      <li key={mission.day}>
                        Day {mission.day}: {mission.title} ({mission.passed ? "skipped" : "failed"})
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="hint">No failed or skipped missions on record.</p>
                )}
              </div>
            )}
            <div className="selector-actions">
              <button className="btn btn-primary" type="button" disabled={!selectedId || busy} onClick={startInterview}>
                Start interview
              </button>
              {busy && (
                <span className="loading-row" aria-live="polite">
                  <span className="spinner" aria-hidden="true" />
                  <span>Preparing first question…</span>
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      {stage === "interview" && (
        <>
          <section className="card" aria-label="Interview chat">
            <h2>
              Interviewing {selected ? selected.member.name : ""}
            </h2>
            <div className="chat">
              <div className="chat-log" ref={logRef} role="log" aria-live="polite">
                {messages.length === 0 && !busy && (
                  <p className="hint">The interview has not started yet.</p>
                )}
                {messages.map((message) => {
                  if (message.role === "interviewer") {
                    const { day, text } = splitDayTag(message.content);
                    return (
                      <div key={message.id} className="msg msg-interviewer">
                        {day && <span className="day-chip">Day {day}</span>}
                        {text}
                      </div>
                    );
                  }
                  return (
                    <div key={message.id} className="msg msg-candidate">
                      {message.content}
                    </div>
                  );
                })}
                {busy && (
                  <div className="loading-row" aria-live="polite">
                    <span className="spinner" aria-hidden="true" />
                    <span>Thinking…</span>
                  </div>
                )}
              </div>

              <form className="chat-composer" onSubmit={onComposerSubmit}>
                <div className="field">
                  <label htmlFor="answer-input">Your answer</label>
                  <textarea
                    id="answer-input"
                    ref={textareaRef}
                    className="textarea"
                    rows={3}
                    placeholder="Type your answer as the candidate…"
                    value={input}
                    disabled={busy || reportLoading}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendAnswer();
                      }
                    }}
                  />
                </div>
                <div className="chat-composer-row">
                  <button className="btn btn-primary" type="submit" disabled={!input.trim() || busy || reportLoading}>
                    {busy ? "Sending…" : "Send answer"}
                  </button>
                </div>
              </form>

              <div className="progress-line" aria-label="Interview progress">
                <span>
                  Questions: <strong>{questionsAsked}</strong>
                </span>
                <span>
                  Topics covered: <strong>{daysCovered}</strong>
                </span>
              </div>

              {error && (
                <p className="status status-error" role="alert">
                  {error}
                </p>
              )}

              <div className="selector-actions">
                <button
                  className="btn btn-accent"
                  type="button"
                  disabled={busy || reportLoading || questionsAsked === 0}
                  onClick={() => void finishInterview()}
                >
                  Finish &amp; get feedback
                </button>
                <button className="btn btn-secondary" type="button" disabled={busy || reportLoading} onClick={resetInterview}>
                  New interview
                </button>
              </div>
            </div>
          </section>

          <section className="card" aria-label="Feedback report">
            <h2>Feedback report</h2>
            {reportLoading && !report && (
              <div className="loading-row" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
                <span>Generating feedback…</span>
              </div>
            )}
            {!reportLoading && !report && (
              <p className="report-empty">No report yet. Answer a few questions, then finish to see feedback.</p>
            )}
            {report && (
              <div className="report-section">
                {report.topics.length > 0 && (
                  <div>
                    {report.topics.map((topic) => (
                      <article className="topic" key={topic.day}>
                        <div className="topic-head">
                          <h3>{topic.title}</h3>
                          <span className="topic-meta">Day {topic.day}</span>
                          <span className={`score-chip score-${topic.score}`}>{topic.score}</span>
                        </div>
                        <p>{topic.rationale}</p>
                      </article>
                    ))}
                  </div>
                )}

                {report.gaps.length > 0 && (
                  <div className="list-block">
                    <h3>Gaps</h3>
                    <ul>
                      {report.gaps.map((gap, index) => (
                        <li className="gap-item" key={index}>
                          {gap}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {report.next.length > 0 && (
                  <div className="list-block">
                    <h3>Next steps</h3>
                    <ul>
                      {report.next.map((step, index) => (
                        <li key={index}>{step}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
