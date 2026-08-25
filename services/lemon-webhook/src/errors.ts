export class SafeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "SafeError";
    this.status = status;
    this.code = code;
  }
}

export function asSafeError(error: unknown): SafeError {
  if (error instanceof SafeError) {
    return error;
  }

  return new SafeError(500, "internal_error");
}
