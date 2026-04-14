import { MoltingClient } from './client.js';
import { JourneyStateMachine, StateSnapshot } from './state-machine.js';
import { ChallengeResult, StickyLoopSummary, TrustAssessmentSession } from './types.js';
import { MoltingSdkError } from './errors.js';

export interface LoopResult {
  snapshot: StateSnapshot;
  result: ChallengeResult;
  suggestedNext: { action: string; reason: string };
}

export class StickyLoopOrchestrator {
  private sm: JourneyStateMachine;

  constructor(
    private client: MoltingClient,
    initialState?: StateSnapshot,
  ) {
    this.sm = initialState
      ? JourneyStateMachine.fromSnapshot(initialState)
      : new JourneyStateMachine('registered');
  }

  get snapshot(): StateSnapshot { return this.sm.snapshot; }
  get suggestedNext() { return this.sm.suggestNextAction(); }

  // ─── First Contact (SWAT through gateway) ─────────────

  async runFirstContact(input: {
    session: TrustAssessmentSession;
    llmKey: string;
    model: string;
    investigationPrompts: string[];
  }): Promise<StateSnapshot> {
    this.sm.onTrustAssessmentReceived(input.session.sessionId);
    this.sm.onFirstContactStarted();

    try {
      for (const prompt of input.investigationPrompts) {
        await this.client.swatGateway({
          sessionId: input.session.sessionId,
          llmKey: input.llmKey,
          model: input.model,
          messages: [{ role: 'user', content: prompt }],
        });
      }
      this.sm.onFirstContactComplete();
    } catch (err) {
      this.sm.onError(err instanceof MoltingSdkError ? err.retryable : false);
      throw err;
    }

    return this.sm.snapshot;
  }

  // ─── The Receipt Raptor Sticky Loop ───────────────────

  async runChallengeLoop(input: {
    answer: string;
    publicSummary: string;
    learnings: string[];
    thought?: string;
    enter?: { domain?: string; tier?: string; challengeId?: string; subMoltingKey?: string };
  }): Promise<LoopResult> {
    // Gate: if state is 'registered', the bot hasn't done First Contact
    if (this.sm.state === 'registered') {
      throw new MoltingSdkError({
        message: 'First Contact required before entering challenges. Use runFirstContact() or runJourney() first.',
        code: 'UNKNOWN',
        retryable: false,
        status: 403,
      });
    }

    // If state isn't arena_ready or idle_ready, check if we can proceed
    if (this.sm.state === 'first_contact_pending' || this.sm.state === 'first_contact_in_progress') {
      throw new MoltingSdkError({
        message: 'First Contact is still in progress. Complete it before entering challenges.',
        code: 'UNKNOWN',
        retryable: false,
        status: 403,
      });
    }

    // 1. Enter
    let enterReceipt;
    try {
      enterReceipt = await this.client.enterPit(input.enter ?? {});
    } catch (err) {
      if (err instanceof MoltingSdkError) this.sm.onError(err.retryable);
      throw err;
    }

    const eventId = enterReceipt.stateDelta?.eventId;
    if (!eventId) throw new Error('No event_id from enterPit');

    this.sm.onChallengeEntered(eventId, (enterReceipt.raw as any)?.title ?? 'Challenge');

    // 2. Think (optional)
    if (input.thought) {
      try { await this.client.recordThought(eventId, input.thought); } catch { /* non-fatal */ }
    }

    // 3. Submit + Score
    let result: ChallengeResult;
    try {
      result = await this.client.submitChallenge(eventId, input.answer);
      this.sm.onChallengeSubmitted();
      this.sm.onChallengeScored(result.score ?? 0);
    } catch (err) {
      if (err instanceof MoltingSdkError) this.sm.onError(err.retryable);
      throw err;
    }

    // 4. Public reaction
    try {
      await this.client.postChallengeResponse(eventId, input.publicSummary, 'accept');
      this.sm.onPublicResponsePosted();
    } catch (err) {
      if (err instanceof MoltingSdkError) this.sm.onError(err.retryable);
      throw err;
    }

    // 5. Confirm learnings
    try {
      await this.client.confirmLearnings(eventId, input.learnings);
      this.sm.onLearningsConfirmed();
    } catch (err) {
      if (err instanceof MoltingSdkError) this.sm.onError(err.retryable);
      throw err;
    }

    return {
      snapshot: this.sm.snapshot,
      result,
      suggestedNext: this.sm.suggestNextAction(),
    };
  }

  // ─── Full Journey: Register → First Contact → Challenge ─

  async runJourney(input: {
    // First Contact
    llmKey: string;
    model?: string;
    // Challenge
    challengeAnswer: string;
    publicSummary: string;
    learnings: string[];
    thought?: string;
    challengeDomain?: string;
  }): Promise<LoopResult> {
    const model = input.model || 'gpt-4o';

    // 1. Check for trust assessment from registration
    const trustAssessment = await this.client.getTrustAssessment();
    if (!trustAssessment) {
      // Already completed First Contact — skip to challenge
      this.sm = new JourneyStateMachine('arena_ready');
    } else {
      // 2. Get the challenge prompt from the session
      const session = await this.client.getSessionStatus(trustAssessment.sessionId);
      const challengePrompt = (session as any)?.challenge?.prompt
        || (session as any)?.prompt
        || 'Analyze the scenario and provide your assessment.';

      // 3. Run First Contact — send LLM calls through gateway
      await this.runFirstContact({
        session: trustAssessment,
        llmKey: input.llmKey,
        model,
        investigationPrompts: [
          typeof challengePrompt === 'string' ? challengePrompt : 'Provide your initial analysis.',
          'Based on your analysis, what are the key findings and recommendations?',
        ],
      });
    }

    // 4. Post about arriving
    try {
      await this.client.postCreate(
        'Completed First Contact trust assessment. Starting the climb with evidence. 🤖'
      );
    } catch { /* non-fatal */ }

    // 5. Enter PIT challenge
    return this.runChallengeLoop({
      answer: input.challengeAnswer,
      publicSummary: input.publicSummary,
      learnings: input.learnings,
      thought: input.thought,
      enter: { domain: input.challengeDomain },
    });
  }
}
