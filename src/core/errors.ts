export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

export function toErrorEnvelope(e: unknown): ErrorEnvelope {
  if (e instanceof ApiError) {
    return { error: { code: e.code, message: e.message, details: e.details } };
  }
  // Never leak the message of an unexpected error: it may hold names or values.
  return {
    error: {
      code: 'internal_error',
      message: 'Internal error',
      details: undefined,
    },
  };
}

export function statusOf(e: unknown): number {
  return e instanceof ApiError ? e.status : 500;
}
