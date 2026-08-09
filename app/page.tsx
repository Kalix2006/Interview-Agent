'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createInitialVoiceContext,
  detectBrowserSupport,
  END_OF_TURN_SILENCE_MS,
  IDLE_PROMPT_MS,
  reduce,
  type Decision,
  type VoiceContext,
  type VoiceEvent,
} from '../lib/voice-state-machine';

type CandidateMission = { day: number; title: string; passed?: boolean; skipped?: boolean };
type Candidate = {
  member: { id: string; name: string; jobRole: string; yearsExperience: number };
  missions: CandidateMission[];
};

type Message = { id: string; role: 'interviewer' | 'candidate'; content: string; day?: number };

type Score = 'low' | 'medium' | 'high';
type Report = {
  topics: { day: number; title: string; score: Score; rationale: string }[];
  gaps: string[];
  next: string[];
};

const RATE_LIMIT_MS = 7000;
const IDLE_PROMPT_TEXT = 'Take your time. Are you still there?';

function stripDayTag(content: string): { day: number | null; text: string } {
  const match = /^\[D:(\d+)\]\s*/i.exec(content);
  if (!match) return { day: null, text: content };
  return { day: Number(match[1]), text: content.slice(match[0].length) };
}

type SpeechResultEvent = {
  resultIndex: number;
  results: { isFinal: boolean; 0: { transcript: string } }[];
};
type RecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
};
type RecognitionCtor = new () => RecognitionInstance;

export default function Home() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browserSupport, setBrowserSupport] = useState<{ ok: boolean; reason: string } | null>(null);
  const [voiceContext, setVoiceContext] = useState<VoiceContext>(createInitialVoiceContext());
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);

  const voiceContextRef = useRef(voiceContext);
  const messagesRef = useRef(messages);
  const pausedRef = useRef(paused);
  const mutedRef = useRef(muted);
  const selectedIdRef = useRef(selectedId);
  const recognitionRef = useRef<RecognitionInstance | null>(null);
  const listeningIntentRef = useRef(false);
  const turnInFlightRef = useRef(false);
  const lastCallAtRef = useRef(0);
  const partialTranscriptRef = useRef('');
  const lastQuestionTextRef = useRef('');
  const idleTimerRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const pendingResumeRef = useRef<'speak' | 'listen' | null>(null);
  const recognitionCtorRef = useRef<RecognitionCtor | null>(null);

  useEffect(() => {
    voiceContextRef.current = voiceContext;
  }, [voiceContext]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const support = detectBrowserSupport();
    setBrowserSupport(support);
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    recognitionCtorRef.current = w.SpeechRecognition || w.webkitSpeechRecognition || null;
  }, []);

  useEffect(() => {
    if (candidates.length === 0) {
      fetch('/api/candidates')
        .then((r) => r.json())
        .then((d) => setCandidates(d.candidates ?? []))
        .catch(() => setError('Failed to load candidate list.'));
    }
  }, [candidates.length]);

  useEffect(() => {
    const el = document.getElementById('transcript');
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, voiceContext.phase]);

  const clearTimers = () => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  const stopListening = () => {
    listeningIntentRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      try {
        recognitionRef.current.stop();
      } catch {
        /* already stopped */
      }
      recognitionRef.current = null;
    }
  };

  const speakText = (text: string, onDone: () => void) => {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.onend = () => onDone();
    utterance.onerror = () => onDone();
    window.speechSynthesis.speak(utterance);
  };

  const startTurn = () => {
    const history = messagesRef.current.map((m) => ({ role: m.role, content: m.content }));
    fetch('/api/interview/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId: selectedIdRef.current, history }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? 'The interview service did not respond.');
        }
        return res.json();
      })
      .then((data) => {
        if (data.done) {
          dispatch({ type: 'TURN_RESPONSE', hasNext: false, question: '' });
          return;
        }
        const { day, text } = stripDayTag(String(data.reply ?? ''));
        const message: Message = {
          id: crypto.randomUUID(),
          role: 'interviewer',
          content: text,
          day: day ?? undefined,
        };
        setMessages((prev) => [...prev, message]);
        dispatch({ type: 'TURN_RESPONSE', hasNext: true, question: text });
      })
      .catch((err) => {
        dispatch({ type: 'FAILED', error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        turnInFlightRef.current = false;
      });
  };

  const throttle = async () => {
    const now = Date.now();
    const wait = lastCallAtRef.current + RATE_LIMIT_MS - now;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastCallAtRef.current = Date.now();
  };

  const startListening = () => {
    if (pausedRef.current || mutedRef.current) {
      pendingResumeRef.current = 'listen';
      return;
    }
    if (listeningIntentRef.current) return;
    const ctor = recognitionCtorRef.current;
    if (!ctor) return;
    listeningIntentRef.current = true;
    const recognition = new ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onresult = (event) => {
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalText += event.results[i][0].transcript;
        }
      }
      if (!finalText.trim()) return;
      partialTranscriptRef.current = finalText.trim();
      dispatch({ type: 'SPEECH_DETECTED', transcript: partialTranscriptRef.current });
      clearTimers();
      silenceTimerRef.current = window.setTimeout(() => {
        const transcript = partialTranscriptRef.current;
        partialTranscriptRef.current = '';
        silenceTimerRef.current = null;
        dispatch({ type: 'SUBMIT_ANSWER', transcript });
      }, END_OF_TURN_SILENCE_MS);
    };
    recognition.onend = () => {
      if (listeningIntentRef.current && !pausedRef.current) {
        try {
          recognition.start();
        } catch {
          /* recognition still starting */
        }
      }
    };
    recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        dispatch({ type: 'FAILED', error: 'Microphone access is required. Enable it in your browser and try again.' });
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        console.error('Speech recognition error:', e.error);
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      /* start() threw; onerror will surface it */
    }
    clearTimers();
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      dispatch({ type: 'IDLE_TIMEOUT' });
    }, IDLE_PROMPT_MS);
  };

  const handleDecision = (decision: Decision) => {
    switch (decision.kind) {
      case 'noop':
        return;
      case 'speak': {
        lastQuestionTextRef.current = decision.text;
        if (mutedRef.current) return;
        speakText(decision.text, () => dispatch({ type: 'AI_SPEECH_ENDED' }));
        return;
      }
      case 'start_listening':
        startListening();
        return;
      case 'prompt_idle': {
        stopListening();
        clearTimers();
        const promptThenListen = () => {
          if (mutedRef.current) {
            startListening();
            return;
          }
          speakText(IDLE_PROMPT_TEXT, () => startListening());
        };
        promptThenListen();
        return;
      }
      case 'request_turn': {
        const content = decision.transcript || '[No response]';
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'candidate', content }]);
        if (turnInFlightRef.current) return;
        turnInFlightRef.current = true;
        void throttle().then(startTurn);
        return;
      }
      case 'request_feedback': {
        stopListening();
        clearTimers();
        const history = messagesRef.current.map((m) => ({ role: m.role, content: m.content }));
        fetch('/api/interview/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history }),
        })
          .then(async (res) => {
            if (!res.ok) throw new Error('Failed to generate feedback report.');
            return res.json();
          })
          .then((data) => setReport(data))
          .catch((err) => setError(err instanceof Error ? err.message : String(err)));
        return;
      }
      case 'set_error':
        setError(decision.message);
        return;
      case 'reset':
        setMessages([]);
        setReport(null);
        setError(null);
        return;
    }
  };

  const dispatch = (event: VoiceEvent) => {
    const result = reduce(voiceContextRef.current, event);
    voiceContextRef.current = result.context;
    setVoiceContext(result.context);
    for (const decision of result.decisions) {
      handleDecision(decision);
    }
  };

  const startInterview = () => {
    if (!selectedId || browserSupport?.ok === false) return;
    setError(null);
    setReport(null);
    setMessages([]);
    dispatch({ type: 'START_INTERVIEW' });
  };

  const togglePause = () => {
    if (!paused) {
      setPaused(true);
      window.speechSynthesis.cancel();
      const phase = voiceContextRef.current.phase;
      pendingResumeRef.current = phase === 'speaking' ? 'speak' : phase === 'listening' ? 'listen' : null;
      stopListening();
      clearTimers();
    } else {
      setPaused(false);
      const resume = pendingResumeRef.current;
      pendingResumeRef.current = null;
      if (resume === 'speak') {
        const text = lastQuestionTextRef.current;
        if (text && !mutedRef.current) {
          speakText(text, () => dispatch({ type: 'AI_SPEECH_ENDED' }));
        }
      } else if (resume === 'listen') {
        startListening();
      }
    }
  };

  const toggleMute = () => {
    if (!muted) {
      setMuted(true);
      window.speechSynthesis.cancel();
    } else {
      setMuted(false);
      if (voiceContextRef.current.phase === 'speaking' && lastQuestionTextRef.current) {
        speakText(lastQuestionTextRef.current, () => dispatch({ type: 'AI_SPEECH_ENDED' }));
      }
    }
  };

  const resetInterview = () => {
    window.speechSynthesis.cancel();
    stopListening();
    clearTimers();
    setPaused(false);
    setMuted(false);
    pendingResumeRef.current = null;
    turnInFlightRef.current = false;
    partialTranscriptRef.current = '';
    dispatch({ type: 'RESET' });
  };

  const candidate = candidates.find((c) => c.member.id === selectedId);
  const weakAreas = candidate?.missions.filter((m) => !m.passed || m.skipped) ?? [];
  const topicsCovered = new Set(
    messages.filter((m) => m.role === 'interviewer' && m.day != null).map((m) => m.day)
  ).size;
  const phase = voiceContext.phase;
  const inSession = phase !== 'setup';

  const stateLabel: Record<string, string> = {
    setup: 'Ready',
    connecting: 'Connecting',
    listening: 'Listening',
    processing: 'Thinking',
    speaking: 'Your turn',
    complete: 'Complete',
    error: 'Error',
  };
  const stateClass: Record<string, string> = {
    setup: 'state-indicator--idle',
    connecting: 'state-indicator--thinking',
    listening: 'state-indicator--listening',
    processing: 'state-indicator--thinking',
    speaking: 'state-indicator--speaking',
    complete: 'state-indicator--idle',
    error: 'state-indicator--idle',
  };

  return (
    <div className="app">
      <header className="top-bar">
        <div className="top-bar__left">
          <div>
            <div className="top-bar__name">{candidate ? candidate.member.name : 'Interview Agent'}</div>
            {candidate && (
              <div className="top-bar__role">
                {candidate.member.jobRole} · {candidate.member.yearsExperience}y exp
              </div>
            )}
          </div>
        </div>
        <div className="top-bar__right">
          {inSession && (
            <div className={`state-indicator ${stateClass[phase]}`} aria-live="polite">
              {phase === 'processing' || phase === 'connecting' ? (
                <span className="thinking-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              ) : (
                <span className="state-dot" aria-hidden="true" />
              )}
              <span>{stateLabel[phase]}</span>
            </div>
          )}
          {inSession && (
            <div className="progress" aria-label="Progress">
              Q {voiceContext.questionsAsked} · Topics {topicsCovered}
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          {phase === 'error' && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={resetInterview}>
              Back to setup
            </button>
          )}
        </div>
      )}

      {browserSupport && !browserSupport.ok ? (
        <section className="setup">
          <h1 className="setup__heading">Voice not supported</h1>
          <p className="setup__sub">{browserSupport.reason}</p>
          <p className="setup__sub">Open this page in Chrome or Edge to run the interview hands-free.</p>
        </section>
      ) : (
        <>
          {phase === 'setup' && (
            <section className="setup">
              <h1 className="setup__heading">Ready when you are.</h1>
              <p className="setup__sub">
                A proctored, voice-driven interview. The agent asks, you answer out loud,
                and a feedback report is generated at the end. Allow microphone access when prompted.
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

                {weakAreas.length > 0 && (
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

                <button type="button" className="btn btn--primary" disabled={!selectedId} onClick={startInterview}>
                  Begin interview
                </button>
              </div>
            </section>
          )}

          {inSession && (
            <>
              <main id="transcript" className="transcript" aria-live="polite" aria-label="Interview transcript">
                {messages.map((m) => (
                  <div key={m.id} className={`message message--${m.role}`}>
                    {m.day != null && m.role === 'interviewer' && <span className="message__day">D{m.day}</span>}
                    <div className="message__bubble">{m.content}</div>
                  </div>
                ))}
                {phase === 'listening' && (
                  <div className="listening-hint" aria-hidden="true">
                    <span className="mic-bars">
                      <span />
                      <span />
                      <span />
                      <span />
                    </span>
                    Speak your answer
                  </div>
                )}
              </main>

              {phase !== 'complete' && (
                <div className="voice-bar">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={togglePause}
                    aria-label={paused ? 'Resume interview' : 'Pause interview'}
                    title={paused ? 'Resume' : 'Pause'}
                  >
                    {paused ? '▶' : '❚❚'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={toggleMute}
                    aria-label={muted ? 'Unmute interviewer voice' : 'Mute interviewer voice'}
                    title={muted ? 'Unmute' : 'Mute'}
                  >
                    {muted ? '✕ voice' : '♪ voice'}
                  </button>
                  <div className="waveform" aria-hidden="true">
                    {phase === 'listening' && !paused && !muted ? (
                      <div className="waveform__bars waveform__bars--live">
                        {Array.from({ length: 9 }).map((_, i) => (
                          <div key={i} className={`waveform__bar waveform__bar--${i}`} />
                        ))}
                      </div>
                    ) : (
                      <div className="waveform__bars">
                        {Array.from({ length: 9 }).map((_, i) => (
                          <div key={i} className={`waveform__bar waveform__bar--${i} waveform__bar--still`} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {phase === 'complete' && report && (
            <section className="report" aria-label="Feedback report">
              <div className="report__header">
                <h2 className="report__title">Feedback report</h2>
                <button type="button" className="btn btn--ghost btn--sm" onClick={resetInterview}>
                  New interview
                </button>
              </div>
              <div className="report__topics">
                {report.topics.map((t) => (
                  <div key={t.day} className="report__topic">
                    <div className="report__topic-header">
                      <span className="report__topic-name">
                        D{t.day} · {t.title}
                      </span>
                      <span className={`report__score report__score--${t.score}`}>{t.score}</span>
                    </div>
                    <div className="report__rationale">{t.rationale}</div>
                  </div>
                ))}
              </div>
              {report.gaps.length > 0 && (
                <>
                  <h3 className="report__section-title">Gaps</h3>
                  <ul className="report__list report__list--gaps">
                    {report.gaps.map((g, i) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </>
              )}
              {report.next.length > 0 && (
                <>
                  <h3 className="report__section-title">Recommended next steps</h3>
                  <ul className="report__list">
                    {report.next.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
