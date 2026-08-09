// Pure voice-interaction state machine for the hands-free interview UI.
// The reducer owns phase transitions and policy (idle prompts, submission);
// the page implements the side-effectful decisions (speak, listen, fetch).

export type VoicePhase =
  | 'setup'
  | 'connecting'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'ending'
  | 'complete'
  | 'error';

export interface VoiceContext {
  phase: VoicePhase;
  partialTranscript: string;
  consecutiveIdlePrompts: number;
  questionsAsked: number;
  error?: string;
}

export type VoiceEvent =
  | { type: 'START_INTERVIEW' }
  | { type: 'SPEECH_DETECTED'; transcript: string }
  | { type: 'SUBMIT_ANSWER'; transcript: string }
  | { type: 'IDLE_TIMEOUT' }
  | { type: 'AI_SPEECH_ENDED' }
  | { type: 'TURN_RESPONSE'; hasNext: boolean; question: string }
  | { type: 'CANCEL_END' }
  | { type: 'END_INTERVIEW' }
  | { type: 'FAILED'; error: string }
  | { type: 'RESET' };

export type Decision =
  | { kind: 'noop' }
  | { kind: 'speak'; text: string }
  | { kind: 'start_listening' }
  | { kind: 'prompt_idle' }
  | { kind: 'prompt_end' }
  | { kind: 'request_turn'; transcript: string }
  | { kind: 'request_feedback' }
  | { kind: 'set_error'; message: string }
  | { kind: 'reset' };

export const IDLE_PROMPT_MS = 10000;
export const END_OF_TURN_SILENCE_MS = 4000;
export const IDLE_PROMPTS_BEFORE_END_WARNING = 1;
export const END_WARNING_TIMEOUT_MS = 30000;

export function createInitialVoiceContext(): VoiceContext {
  return {
    phase: 'setup',
    partialTranscript: '',
    consecutiveIdlePrompts: 0,
    questionsAsked: 0,
  };
}

export function reduce(
  context: VoiceContext,
  event: VoiceEvent
): { context: VoiceContext; decisions: Decision[] } {
  switch (event.type) {
    case 'START_INTERVIEW': {
      return {
        context: { ...createInitialVoiceContext(), phase: 'connecting' },
        decisions: [{ kind: 'request_turn', transcript: '' }],
      };
    }

    case 'SPEECH_DETECTED': {
      return {
        context: { ...context, partialTranscript: event.transcript, consecutiveIdlePrompts: 0 },
        decisions: [{ kind: 'noop' }],
      };
    }

    case 'SUBMIT_ANSWER': {
      return {
        context: { ...context, phase: 'processing' },
        decisions: [{ kind: 'request_turn', transcript: event.transcript }],
      };
    }

    case 'IDLE_TIMEOUT': {
      if (context.phase !== 'listening') {
        return { context, decisions: [{ kind: 'noop' }] };
      }
      if (context.consecutiveIdlePrompts >= IDLE_PROMPTS_BEFORE_END_WARNING) {
        return {
          context: { ...context, phase: 'ending', consecutiveIdlePrompts: 0 },
          decisions: [{ kind: 'prompt_end' }],
        };
      }
      return {
        context: { ...context, consecutiveIdlePrompts: context.consecutiveIdlePrompts + 1 },
        decisions: [{ kind: 'prompt_idle' }],
      };
    }

    case 'AI_SPEECH_ENDED': {
      return {
        context: { ...context, phase: 'listening', consecutiveIdlePrompts: 0 },
        decisions: [{ kind: 'start_listening' }],
      };
    }

    case 'CANCEL_END': {
      if (context.phase !== 'ending') {
        return { context, decisions: [{ kind: 'noop' }] };
      }
      return {
        context: { ...context, phase: 'listening', consecutiveIdlePrompts: 0 },
        decisions: [{ kind: 'start_listening' }],
      };
    }

    case 'END_INTERVIEW': {
      if (context.phase !== 'ending') {
        return { context, decisions: [{ kind: 'noop' }] };
      }
      return {
        context: { ...context, phase: 'complete', partialTranscript: '' },
        decisions: [{ kind: 'request_feedback' }],
      };
    }

    case 'TURN_RESPONSE': {
      if (event.hasNext) {
        return {
          context: {
            ...context,
            phase: 'speaking',
            questionsAsked: context.questionsAsked + 1,
            partialTranscript: '',
          },
          decisions: [{ kind: 'speak', text: event.question }],
        };
      }
      return {
        context: { ...context, phase: 'complete', partialTranscript: '' },
        decisions: [{ kind: 'request_feedback' }],
      };
    }

    case 'FAILED': {
      return {
        context: { ...context, phase: 'error', error: event.error },
        decisions: [{ kind: 'set_error', message: event.error }],
      };
    }

    case 'RESET': {
      return {
        context: createInitialVoiceContext(),
        decisions: [{ kind: 'reset' }],
      };
    }

    default: {
      return { context, decisions: [{ kind: 'noop' }] };
    }
  }
}

export function detectBrowserSupport(): { ok: boolean; reason: string } {
  if (typeof window === 'undefined') {
    return { ok: false, reason: 'Voice APIs are only available in the browser.' };
  }
  const w = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  const hasRecognition = Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
  const hasSynthesis = 'speechSynthesis' in window;
  if (!hasRecognition) {
    return { ok: false, reason: 'Voice recognition is not supported in this browser.' };
  }
  if (!hasSynthesis) {
    return { ok: false, reason: 'Voice synthesis is not supported in this browser.' };
  }
  return { ok: true, reason: '' };
}
