'use client';

import { useState, useEffect, useRef, useCallback, FormEvent } from 'react';

type Candidate = {
  member: {
    id: string;
    name: string;
    jobRole: string;
    yearsExperience: number;
  };
  missions: { day: number; title: string; passed?: boolean; skipped?: boolean }[];
};

type Message = {
  id: string;
  role: 'interviewer' | 'candidate';
  content: string;
  day?: number;
};

type Score = 'low' | 'medium' | 'high';

type Topic = { day: number; title: string; score: Score; rationale: string };

type Report = {
  topics: Topic[];
  gaps: string[];
  next: string[];
};

type InterviewState = 'setup' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'complete';

const RATE_LIMIT_MS = 7000;

function stripDayTag(content: string): { day: number | null; text: string } {
  const match = /^\[D:(\d+)\]\s*/i.exec(content);
  if (!match) return { day: null, text: content };
  return { day: Number(match[1]), text: content.slice(match[0].length) };
}

export default function Home() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [state, setState] = useState<InterviewState>('setup');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [questionsAsked, setQuestionsAsked] = useState(0);
  const [topicsCovered, setTopicsCovered] = useState(0);

  const lastCallAt = useRef<number>(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch('/api/candidates')
      .then((r) => r.json())
      .then((d) => setCandidates(d.candidates ?? []))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, state]);

  useEffect(() => {
    if (state === 'speaking') inputRef.current?.focus();
  }, [state]);

  const throttle = useCallback(async () => {
    const now = Date.now();
    const elapsed = now - lastCallAt.current;
    if (lastCallAt.current > 0 && elapsed < RATE_LIMIT_MS) {
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
    }
    lastCallAt.current = Date.now();
  }, []);

  const candidate = candidates.find((c) => c.member.id === selectedId);
  const weakAreas = candidate?.missions.filter((m) => m.passed === false || m.skipped === true) ?? [];

  const startInterview = async () => {
    if (!selectedId || state === 'connecting') return;
    setError(null);
    setMessages([]);
    setReport(null);
    setQuestionsAsked(0);
    setTopicsCovered(0);
    setState('connecting');

    try {
      await throttle();
      const res = await fetch('/api/interview/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: selectedId, history: [] }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to start interview');
      const data = await res.json();
      const { day, text } = stripDayTag(data.reply);
      setMessages([{ id: crypto.randomUUID(), role: 'interviewer', content: text, day: day ?? undefined }]);
      setQuestionsAsked(1);
      setTopicsCovered(1);
      setState('speaking');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection error');
      setState('setup');
    }
  };

  const sendAnswer = async () => {
    const text = input.trim();
    if (!text || state !== 'speaking') return;
    setInput('');
    const candidateMsg: Message = { id: crypto.randomUUID(), role: 'candidate', content: text };
    setMessages((prev) => [...prev, candidateMsg]);
    setState('thinking');
    setError(null);

    try {
      await throttle();
      const history = [...messages, candidateMsg].map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch('/api/interview/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: selectedId, history }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to get response');
      const data = await res.json();

      if (data.done) {
        setState('complete');
        setReport(data.feedback ? {
          topics: [],
          gaps: data.feedback.gaps ?? [],
          next: data.feedback.next ?? [],
        } : null);
        void fetchReport(history);
        return;
      }

      const { day, text: qText } = stripDayTag(data.reply);
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'interviewer', content: qText, day: day ?? undefined }]);
      setQuestionsAsked((q) => q + 1);
      if (day && !messages.some((m) => m.day === day)) {
        setTopicsCovered((t) => t + 1);
      }
      setState('speaking');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection error');
      setState('speaking');
    }
  };

  const fetchReport = async (history: { role: string; content: string }[]) => {
    try {
      const res = await fetch('/api/interview/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history }),
      });
      if (res.ok) {
        const data = await res.json();
        setReport(data);
      }
    } catch {}
  };

  const resetInterview = () => {
    setMessages([]);
    setReport(null);
    setQuestionsAsked(0);
    setTopicsCovered(0);
    setError(null);
    setState('setup');
  };

  const onFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    void sendAnswer();
  };

  const stateLabel: Record<InterviewState, string> = {
    setup: 'Ready',
    connecting: 'Connecting',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Your turn',
    complete: 'Complete',
  };

  const stateClass = state === 'speaking' ? 'state-indicator--speaking' :
                     state === 'thinking' || state === 'connecting' ? 'state-indicator--thinking' :
                     state === 'listening' ? 'state-indicator--listening' :
                     'state-indicator--idle';

  return (
    <div className="app">
      <header className="top-bar">
        <div className="top-bar__left">
          <div>
            <div className="top-bar__name">
              {candidate ? candidate.member.name : 'Interview Agent'}
            </div>
            {candidate && (
              <div className="top-bar__role">
                {candidate.member.jobRole} · {candidate.member.yearsExperience}y exp
              </div>
            )}
          </div>
        </div>
        <div className="top-bar__right">
          {state !== 'setup' && (
            <div className={`state-indicator ${stateClass}`} aria-live="polite">
              {state === 'thinking' || state === 'connecting' ? (
                <span className="thinking-dots" aria-hidden="true">
                  <span /><span /><span />
                </span>
              ) : (
                <span className="state-dot" aria-hidden="true" />
              )}
              <span>{stateLabel[state]}</span>
            </div>
          )}
          {state !== 'setup' && (
            <div className="progress" aria-label="Progress">
              Q {questionsAsked} · Topics {topicsCovered}
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      {state === 'setup' && (
        <section className="setup">
          <h1 className="setup__heading">
            Ready when you are.
          </h1>
          <p className="setup__sub">
            This is a proctored interview covering retrieval, agents, vector databases,
            and deployment. Answer at your own pace — take your time.
          </p>

          <div className="setup__form">
            <div className="field">
              <label htmlFor="candidate-select" className="field__label">
                Candidate
              </label>
              <select
                id="candidate-select"
                className="field__select"
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                <option value="">Select a candidate…</option>
                {candidates.map((c) => (
                  <option key={c.member.id} value={c.member.id}>
                    {c.member.name} — {c.member.jobRole}
                  </option>
                ))}
              </select>
            </div>

            {candidate && weakAreas.length > 0 && (
              <div className="setup__context">
                <div className="setup__context-title">Focus areas for this interview</div>
                <ul className="setup__context-list">
                  {weakAreas.map((m) => (
                    <li key={m.day}>
                      <strong>D{m.day}</strong>
                      <span>{m.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <button
              type="button"
              className="btn btn--primary"
              disabled={!selectedId}
              onClick={() => void startInterview()}
            >
              Begin interview
            </button>
          </div>
        </section>
      )}

      {(state !== 'setup') && (
        <>
          <main className="transcript" ref={transcriptRef} aria-live="polite" aria-label="Interview transcript">
            {messages.map((m) => (
              <div key={m.id} className={`message message--${m.role}`}>
                {m.day && m.role === 'interviewer' && (
                  <span className="message__day">D{m.day}</span>
                )}
                <div className="message__bubble">
                  {m.content}
                </div>
              </div>
            ))}

            {report && state === 'complete' && (
              <section className="report" aria-label="Interview report">
                <div className="report__header">
                  <h2 className="report__title">Your report</h2>
                  <button className="report__close" onClick={resetInterview}>
                    Start over
                  </button>
                </div>

                {report.topics.length > 0 && (
                  <div className="report__topics">
                    {report.topics.map((t) => (
                      <article key={t.day} className="report__topic">
                        <div className="report__topic-header">
                          <span className="report__topic-name">
                            D{t.day} · {t.title}
                          </span>
                          <span className={`report__score report__score--${t.score}`}>
                            {t.score}
                          </span>
                        </div>
                        <p className="report__rationale">{t.rationale}</p>
                      </article>
                    ))}
                  </div>
                )}

                {report.gaps.length > 0 && (
                  <>
                    <h3 className="report__section-title">Areas to revisit</h3>
                    <ul className="report__list report__list--gaps">
                      {report.gaps.map((g, i) => (
                        <li key={i}>{g}</li>
                      ))}
                    </ul>
                  </>
                )}

                {report.next.length > 0 && (
                  <>
                    <h3 className="report__section-title">Next steps</h3>
                    <ul className="report__list">
                      {report.next.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            )}
          </main>

          {state !== 'complete' && (
            <div className="input-bar">
              <form className="input-bar__form" onSubmit={onFormSubmit}>
                <textarea
                  ref={inputRef}
                  className="input-bar__textarea"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={state === 'speaking' ? 'Answer when ready…' : 'Waiting for the agent…'}
                  disabled={state !== 'speaking'}
                  rows={1}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void sendAnswer();
                    }
                  }}
                  aria-label="Your answer"
                />
                <button
                  type="submit"
                  className="input-bar__send"
                  disabled={state !== 'speaking' || !input.trim()}
                  aria-label="Send answer"
                >
                  →
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}
