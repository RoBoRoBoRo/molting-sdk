export type MoltingErrorCode =
  | 'UPSTREAM_PROVIDER_ERROR'
  | 'USAGE_EXCEEDED'
  | 'RATE_LIMITED'
  | 'SESSION_TIMEOUT_RECOVERABLE'
  | 'STATE_NOT_RECONCILED'
  | 'CHALLENGE_ALREADY_IN_PROGRESS'
  | 'ACTIVE_EVENT_EXISTS'
  | 'OPS_CENTER_UNAVAILABLE'
  | 'AUTH_INVALID'
  | 'CALLBACK_VERIFICATION_FAILED'
  | 'MISSING_REQUIRED_FIELD'
  | 'CHALLENGE_SUBMISSION_REJECTED'
  | 'UNKNOWN';

export class MoltingSdkError extends Error {
  code: MoltingErrorCode;
  retryable: boolean;
  status?: number;
  details?: unknown;

  constructor(input: {
    message: string;
    code: MoltingErrorCode;
    retryable: boolean;
    status?: number;
    details?: unknown;
  }) {
    super(input.message);
    this.name = 'MoltingSdkError';
    this.code = input.code;
    this.retryable = input.retryable;
    this.status = input.status;
    this.details = input.details;
  }
}

export function classifyMoltingError(status: number, body: string): MoltingSdkError {
  if (body.includes('upstream_api_error')) {
    return new MoltingSdkError({
      message: 'Upstream provider error',
      code: 'UPSTREAM_PROVIDER_ERROR',
      retryable: true,
      status,
      details: body,
    });
  }

  if (body.includes('usage_exceeded')) {
    return new MoltingSdkError({
      message: 'Usage exceeded',
      code: 'USAGE_EXCEEDED',
      retryable: true,
      status,
      details: body,
    });
  }

  if (body.includes('already in progress')) {
    return new MoltingSdkError({
      message: 'Challenge already in progress',
      code: 'CHALLENGE_ALREADY_IN_PROGRESS',
      retryable: false,
      status,
      details: body,
    });
  }

  if (body.includes('public_content is required') || body.includes('response is required')) {
    return new MoltingSdkError({
      message: 'Request shape rejected by platform',
      code: 'MISSING_REQUIRED_FIELD',
      retryable: false,
      status,
      details: body,
    });
  }

  if (status === 401) {
    return new MoltingSdkError({
      message: 'Authentication invalid',
      code: 'AUTH_INVALID',
      retryable: false,
      status,
      details: body,
    });
  }

  if (status === 429) {
    return new MoltingSdkError({
      message: 'Rate limited',
      code: 'RATE_LIMITED',
      retryable: true,
      status,
      details: body,
    });
  }

  return new MoltingSdkError({
    message: 'Unknown Molting error',
    code: 'UNKNOWN',
    retryable: status >= 500,
    status,
    details: body,
  });
}
