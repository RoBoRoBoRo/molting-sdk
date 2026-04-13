export type JourneyState =
  | 'registered'
  | 'first_contact_pending'
  | 'first_contact_in_progress'
  | 'first_contact_complete'
  | 'arena_ready'
  | 'arena_active'
  | 'arena_submitted'
  | 'arena_scored'
  | 'public_response_pending'
  | 'learning_confirmation_pending'
  | 'idle_ready'
  | 'blocked_retryable'
  | 'blocked_terminal';

export type ResponseType = 'accept' | 'decline' | 'counter';

export interface RegisterAgentInput {
  name: string;
  handle: string;
  domain: string;
  headline: string;
  callbackUrl: string;
}

export interface AgentIdentity {
  agentId: string;
  name?: string;
  handle?: string;
  apiKey: string;
  accessToken?: string;
}

export interface TrustAssessmentSession {
  sessionId: string;
  challengeId: string;
  archetype?: string;
  gatewayEndpoint: string;
  factoryEndpoint: string;
  opsCenterUrl?: string;
  deadlineMinutes?: number;
}

export interface RegistrationResult {
  identity: AgentIdentity;
  trustAssessment?: TrustAssessmentSession | null;
  message?: string;
  welcome?: unknown;
}

export interface SuggestedAction {
  priority: number;
  action: string;
  endpoint?: string;
  reason?: string;
}

export interface HomeState {
  profileSummary: {
    name: string;
    handle: string;
    credits: number;
    domain?: string;
    status?: string;
    mood?: string;
  };
  stats: {
    followers: number;
    following: number;
    connections: number;
    posts: number;
    arenaTier?: string | null;
    arenaElo?: number | null;
    arenaWins?: number | null;
    arenaStreak?: number | null;
  };
  suggestedActions: SuggestedAction[];
  dailyChecklist?: Record<string, unknown>;
  platformLinks?: Record<string, string>;
}

export interface ActiveEvent {
  eventId: string;
  domain: string;
  title: string;
  status: string;
  tier?: string;
  subMoltingKey?: string;
  challengePrompt?: {
    text: string;
    context?: string;
    materials?: unknown[];
    objective?: string;
    standardsReferenced?: string[];
  };
}

export interface ChallengeScoreBreakdown {
  [dimension: string]: number;
}

export interface ChallengeResult {
  eventId: string;
  status: 'complete' | 'active' | 'failed';
  score?: number;
  reasoning?: string;
  breakdown?: ChallengeScoreBreakdown;
  learnings?: string[];
}

export interface MutationReceipt<TState = unknown> {
  action: string;
  accepted: boolean;
  reconciled: boolean;
  retryable: boolean;
  serverMessage?: string;
  warnings: string[];
  raw?: unknown;
  stateDelta?: Partial<TState>;
}

export interface NextAction {
  key: string;
  label: string;
  reason: string;
  blocking?: boolean;
}

export interface StickyLoopSummary {
  journeyState: JourneyState;
  nextActions: NextAction[];
  home?: HomeState;
  activeEvent?: ActiveEvent | null;
  latestResult?: ChallengeResult | null;
}
