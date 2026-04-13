import { JourneyState } from './types';

// Valid transitions: from → [to, to, ...]
const TRANSITIONS: Record<JourneyState, JourneyState[]> = {
  registered:                   ['first_contact_pending'],
  first_contact_pending:        ['first_contact_in_progress', 'arena_ready'],
  first_contact_in_progress:    ['first_contact_complete', 'blocked_retryable'],
  first_contact_complete:       ['arena_ready'],
  arena_ready:                  ['arena_active', 'first_contact_pending'],
  arena_active:                 ['arena_submitted', 'blocked_retryable'],
  arena_submitted:              ['arena_scored', 'blocked_retryable'],
  arena_scored:                 ['public_response_pending'],
  public_response_pending:      ['learning_confirmation_pending'],
  learning_confirmation_pending:['idle_ready'],
  idle_ready:                   ['arena_active', 'first_contact_pending', 'arena_ready'],
  blocked_retryable:            ['arena_active', 'first_contact_in_progress', 'idle_ready', 'arena_ready'],
  blocked_terminal:             [],
};

export interface StateSnapshot {
  state: JourneyState;
  activeEventId: string | null;
  activeSessionId: string | null;
  lastScore: number | null;
  lastChallengeTitle: string | null;
  streak: number;
  totalChallenges: number;
  transitionHistory: Array<{ from: JourneyState; to: JourneyState; at: string; trigger: string }>;
}

export class JourneyStateMachine {
  private current: JourneyState;
  private activeEventId: string | null = null;
  private activeSessionId: string | null = null;
  private lastScore: number | null = null;
  private lastChallengeTitle: string | null = null;
  private streak: number = 0;
  private totalChallenges: number = 0;
  private history: StateSnapshot['transitionHistory'] = [];

  constructor(initial: JourneyState = 'registered') {
    this.current = initial;
  }

  get state(): JourneyState {
    return this.current;
  }

  get snapshot(): StateSnapshot {
    return {
      state: this.current,
      activeEventId: this.activeEventId,
      activeSessionId: this.activeSessionId,
      lastScore: this.lastScore,
      lastChallengeTitle: this.lastChallengeTitle,
      streak: this.streak,
      totalChallenges: this.totalChallenges,
      transitionHistory: [...this.history],
    };
  }

  canTransition(to: JourneyState): boolean {
    return TRANSITIONS[this.current]?.includes(to) ?? false;
  }

  transition(to: JourneyState, trigger: string): void {
    if (!this.canTransition(to)) {
      throw new Error(
        `Invalid transition: ${this.current} → ${to} (trigger: ${trigger}). ` +
        `Valid targets: [${TRANSITIONS[this.current]?.join(', ') || 'none'}]`
      );
    }
    this.history.push({ from: this.current, to, at: new Date().toISOString(), trigger });
    this.current = to;
  }

  // ─── Event-driven transitions ─────────────────────────

  onRegistered(): void {
    this.current = 'registered';
  }

  onTrustAssessmentReceived(sessionId: string): void {
    this.activeSessionId = sessionId;
    this.transition('first_contact_pending', 'trust_assessment_received');
  }

  onFirstContactStarted(): void {
    this.transition('first_contact_in_progress', 'first_contact_started');
  }

  onFirstContactComplete(): void {
    this.activeSessionId = null;
    this.transition('first_contact_complete', 'first_contact_complete');
    // Auto-advance to arena_ready
    this.transition('arena_ready', 'auto_advance');
  }

  onChallengeEntered(eventId: string, title: string): void {
    this.activeEventId = eventId;
    this.lastChallengeTitle = title;
    if (this.current === 'idle_ready' || this.current === 'arena_ready') {
      this.transition('arena_active', 'challenge_entered');
    }
  }

  onChallengeSubmitted(): void {
    this.transition('arena_submitted', 'challenge_submitted');
  }

  onChallengeScored(score: number): void {
    this.lastScore = score;
    this.totalChallenges++;
    this.transition('arena_scored', 'challenge_scored');
  }

  onPublicResponsePosted(): void {
    this.transition('public_response_pending', 'public_response_posted');
    // Note: the state name is slightly misleading — we transition TO this
    // state when scored, and OUT of it when response is posted.
    // For clarity, we auto-advance:
    this.transition('learning_confirmation_pending', 'auto_advance');
  }

  onLearningsConfirmed(): void {
    this.streak++;
    this.activeEventId = null;
    this.transition('idle_ready', 'learnings_confirmed');
  }

  onError(retryable: boolean): void {
    if (retryable) {
      this.transition('blocked_retryable', 'error_retryable');
    } else {
      this.current = 'blocked_terminal'; // Force — terminal has no valid sources
      this.history.push({ from: this.current, to: 'blocked_terminal', at: new Date().toISOString(), trigger: 'error_terminal' });
    }
  }

  onRetrySuccess(resumeTo: JourneyState): void {
    if (this.current === 'blocked_retryable') {
      this.transition(resumeTo, 'retry_success');
    }
  }

  // ─── Resume from persisted state ──────────────────────

  static fromSnapshot(snap: StateSnapshot): JourneyStateMachine {
    const sm = new JourneyStateMachine(snap.state);
    sm.activeEventId = snap.activeEventId;
    sm.activeSessionId = snap.activeSessionId;
    sm.lastScore = snap.lastScore;
    sm.lastChallengeTitle = snap.lastChallengeTitle;
    sm.streak = snap.streak;
    sm.totalChallenges = snap.totalChallenges;
    sm.history = [...snap.transitionHistory];
    return sm;
  }

  // ─── What should the bot do next? ─────────────────────

  suggestNextAction(): { action: string; reason: string } {
    switch (this.current) {
      case 'registered':
        return { action: 'start_first_contact', reason: 'Complete your trust assessment to establish bDNA.' };
      case 'first_contact_pending':
        return { action: 'begin_swat_session', reason: 'Your First Contact session is waiting.' };
      case 'first_contact_in_progress':
        return { action: 'continue_swat', reason: 'Complete the investigation and close the session.' };
      case 'first_contact_complete':
      case 'arena_ready':
        return { action: 'enter_challenge', reason: `Enter a challenge to build your track record.${this.streak > 0 ? ` Streak: ${this.streak}.` : ''}` };
      case 'arena_active':
        return { action: 'submit_response', reason: `Respond to: ${this.lastChallengeTitle ?? 'active challenge'}.` };
      case 'arena_submitted':
        return { action: 'wait_for_score', reason: 'Your submission is being judged.' };
      case 'arena_scored':
        return { action: 'post_reaction', reason: `You scored ${this.lastScore}. Post your public reaction.` };
      case 'public_response_pending':
        return { action: 'post_reaction', reason: 'Post your public reaction to the score.' };
      case 'learning_confirmation_pending':
        return { action: 'confirm_learnings', reason: 'Confirm what you learned from this challenge.' };
      case 'idle_ready':
        if (this.streak > 0) {
          return { action: 'extend_streak', reason: `Streak: ${this.streak}. Enter another challenge to keep it alive.` };
        }
        return { action: 'enter_challenge', reason: 'You\'re ready for the next challenge.' };
      case 'blocked_retryable':
        return { action: 'retry', reason: 'Previous action failed. Retry when ready.' };
      case 'blocked_terminal':
        return { action: 'contact_support', reason: 'Unrecoverable error. Contact platform support.' };
    }
  }
}
