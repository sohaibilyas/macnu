import { SafeError } from "./errors";

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectObject(value: unknown, code = "invalid_payload"): JsonObject {
  if (!isJsonObject(value)) {
    throw new SafeError(400, code);
  }

  return value;
}

export function expectArray(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new SafeError(502, code);
  }

  return value;
}

export function expectString(
  value: unknown,
  status: number,
  code: string,
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new SafeError(status, code);
  }

  return value;
}

export function expectPositiveInteger(value: unknown, status: number, code: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
    throw new SafeError(status, code);
  }

  return value;
}

export function expectNonNegativeInteger(
  value: unknown,
  status: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw new SafeError(status, code);
  }

  return value;
}

export function expectBoolean(value: unknown, status: number, code: string): boolean {
  if (typeof value !== "boolean") {
    throw new SafeError(status, code);
  }

  return value;
}

export function expectBooleanLike(value: unknown, status: number, code: string): boolean {
  if (value === true || value === 1) {
    return true;
  }

  if (value === false || value === 0) {
    return false;
  }

  throw new SafeError(status, code);
}

export function expectNullableNonNegativeInteger(
  value: unknown,
  status: number,
  code: string,
): number | null {
  if (value === null) {
    return null;
  }

  return expectNonNegativeInteger(value, status, code);
}

export async function readRequestBody(request: Request, limit: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");

  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new SafeError(400, "invalid_content_length");
    }

    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength)) {
      throw new SafeError(400, "invalid_content_length");
    }

    if (declaredLength > limit) {
      throw new SafeError(413, "payload_too_large");
    }
  }

  return readStreamWithLimit(request.body, limit, 413, "payload_too_large");
}

export async function readResponseJson(response: Response, limit: number): Promise<unknown> {
  const bytes = await readStreamWithLimit(
    response.body,
    limit,
    502,
    "upstream_response_too_large",
  );

  return parseJson(bytes, 502, "upstream_invalid_json");
}

export function parseJson(bytes: Uint8Array, status: number, code: string): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new SafeError(status, code);
  }
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  status: number,
  code: string,
): Promise<Uint8Array> {
  if (stream === null) {
    return new Uint8Array();
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      total += result.value.byteLength;
      if (total > limit) {
        await reader.cancel(code);
        throw new SafeError(status, code);
      }

      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}
