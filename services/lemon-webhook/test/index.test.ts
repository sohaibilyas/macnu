import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MACNU_BUSINESS_VARIANT_ID,
  MACNU_PERSONAL_VARIANT_ID,
  MACNU_PRODUCT_ID,
  MACNU_STORE_ID,
  MAX_WEBHOOK_BODY_BYTES,
} from "../src/constants";
import { handleRequest } from "../src/index";
import type { Fetcher } from "../src/lemon-api";

const WEBHOOK_URL = "https://webhook.example/webhooks/lemon-squeezy";
const WEBHOOK_SECRET = "test-webhook-secret";
const API_KEY = "test-api-key";
const LICENSE_ID = "501";
const ORDER_ID = 201;
const ORDER_ITEM_ID = 301;

const TEST_ENV: Env = {
  LEMON_WEBHOOK_SECRET: WEBHOOK_SECRET,
  LEMON_API_KEY: API_KEY,
};

let capturedErrorLogs: string[] = [];

beforeEach(() => {
  capturedErrorLogs = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    capturedErrorLogs.push(values.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("routing and authentication", () => {
  it("serves a minimal health endpoint without upstream calls", async () => {
    const fetcher = vi.fn<Fetcher>();
    const response = await handleRequest(
      new Request("https://webhook.example/healthz"),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "macnu-lemon-webhook" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature before any API request", async () => {
    const fetcher = vi.fn<Fetcher>();
    const response = await handleRequest(
      new Request(WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": "0".repeat(64),
        },
        body: JSON.stringify(licenseCreatedPayload()),
      }),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "invalid_signature" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds a streamed request body even without Content-Length", async () => {
    const fetcher = vi.fn<Fetcher>();
    const response = await handleRequest(
      new Request(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1),
      }),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: "payload_too_large" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("acknowledges unsupported signed events without upstream calls", async () => {
    const fetcher = vi.fn<Fetcher>();
    const response = await handleRequest(
      await signedRequest({ meta: { event_name: "customer_updated" }, data: {} }),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "ignored_event", changed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("license_key_created", () => {
  it("sets the Business activation limit to authoritative quantity times two", async () => {
    const patchBodies: unknown[] = [];
    const fetcher = creationApiMock({ quantity: 3, activationLimit: 2, patchBodies });
    const response = await handleRequest(
      await signedRequest(licenseCreatedPayload()),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: "business_limit_updated",
      changed: 1,
    });
    expect(patchBodies).toEqual([
      {
        data: {
          type: "license-keys",
          id: LICENSE_ID,
          attributes: { activation_limit: 6 },
        },
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("is idempotent when the Business limit is already correct", async () => {
    const patchBodies: unknown[] = [];
    const fetcher = creationApiMock({ quantity: 3, activationLimit: 6, patchBodies });
    const response = await handleRequest(
      await signedRequest(licenseCreatedPayload()),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: "already_configured",
      changed: 0,
    });
    expect(patchBodies).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("never adjusts the Personal variant", async () => {
    const patchBodies: unknown[] = [];
    const fetcher = creationApiMock({
      variantId: MACNU_PERSONAL_VARIANT_ID,
      quantity: 4,
      activationLimit: 2,
      patchBodies,
    });
    const response = await handleRequest(
      await signedRequest(licenseCreatedPayload()),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: "personal_unchanged",
      changed: 0,
    });
    expect(patchBodies).toEqual([]);
  });

  it("does not mutate a test-mode order", async () => {
    const patchBodies: unknown[] = [];
    const fetcher = creationApiMock({ testMode: true, patchBodies });
    const response = await handleRequest(
      await signedRequest(licenseCreatedPayload()),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: "ignored_test_mode",
      changed: 0,
    });
    expect(patchBodies).toEqual([]);
  });

  it("fails closed when authoritative resources disagree", async () => {
    const fetcher = creationApiMock({ orderItemProductId: 999 });
    const response = await handleRequest(
      await signedRequest(licenseCreatedPayload()),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "resource_mismatch" });
  });

  it("returns a retryable response when Lemon Squeezy is not ready", async () => {
    const fetcher = vi.fn<Fetcher>(async (input, init) => {
      const request = new Request(input, init);
      assertApiAuthorization(request);
      return jsonResponse({ errors: [] }, 404);
    });
    const response = await handleRequest(
      await signedRequest(licenseCreatedPayload()),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "upstream_not_ready" });
  });

  it("never logs customer or license-key fields on failure", async () => {
    const sensitiveLicense = "do-not-log-this-license-key";
    const sensitiveEmail = "private-customer@example.com";
    const payload = licenseCreatedPayload();
    const data = payload.data as { attributes: Record<string, unknown> };
    data.attributes.key = sensitiveLicense;
    data.attributes.user_email = sensitiveEmail;

    const fetcher = vi.fn<Fetcher>(async () => {
      throw new Error("network failed");
    });
    const response = await handleRequest(await signedRequest(payload), TEST_ENV, fetcher);

    expect(response.status).toBe(503);
    const logs = capturedErrorLogs.join(" ");
    expect(logs).not.toContain(sensitiveLicense);
    expect(logs).not.toContain(sensitiveEmail);
    expect(logs).not.toContain(JSON.stringify(payload));
  });
});

describe("order_refunded", () => {
  it("disables every matching Macnu license after a full live refund", async () => {
    const patchBodies: unknown[] = [];
    const fetcher = refundApiMock({ patchBodies });
    const response = await handleRequest(
      await signedRequest(orderRefundedPayload()),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: "refund_licenses_disabled",
      changed: 1,
    });
    expect(patchBodies).toEqual([
      {
        data: {
          type: "license-keys",
          id: LICENSE_ID,
          attributes: { disabled: true },
        },
      },
    ]);
  });

  it("is idempotent when refunded licenses are already disabled", async () => {
    const patchBodies: unknown[] = [];
    const fetcher = refundApiMock({ disabled: true, patchBodies });
    const response = await handleRequest(
      await signedRequest(orderRefundedPayload()),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: "refund_already_disabled",
      changed: 0,
    });
    expect(patchBodies).toEqual([]);
  });

  it("does not disable licenses for a partial refund", async () => {
    const fetcher = vi.fn<Fetcher>();
    const response = await handleRequest(
      await signedRequest(
        orderRefundedPayload({ status: "partial_refund", refunded: false }),
      ),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: "ignored_partial_refund",
      changed: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not process a test-mode refund", async () => {
    const fetcher = vi.fn<Fetcher>();
    const response = await handleRequest(
      await signedRequest(orderRefundedPayload({ testMode: true })),
      TEST_ENV,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: "ignored_test_mode",
      changed: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

interface CreationMockOptions {
  variantId?: number;
  quantity?: number;
  activationLimit?: number;
  testMode?: boolean;
  orderItemProductId?: number;
  patchBodies?: unknown[];
}

function creationApiMock(options: CreationMockOptions = {}) {
  const variantId = options.variantId ?? MACNU_BUSINESS_VARIANT_ID;
  const quantity = options.quantity ?? 1;
  const activationLimit = options.activationLimit ?? 2;
  const patchBodies = options.patchBodies ?? [];

  return vi.fn<Fetcher>(async (input, init) => {
    const request = new Request(input, init);
    assertApiAuthorization(request);
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === `/v1/license-keys/${LICENSE_ID}`) {
      return jsonResponse(licenseDocument({ activationLimit }));
    }
    if (request.method === "GET" && url.pathname === `/v1/order-items/${ORDER_ITEM_ID}`) {
      return jsonResponse(
        orderItemDocument({
          productId: options.orderItemProductId ?? MACNU_PRODUCT_ID,
          variantId,
          quantity,
        }),
      );
    }
    if (request.method === "GET" && url.pathname === `/v1/orders/${ORDER_ID}`) {
      return jsonResponse(orderDocument({ testMode: options.testMode ?? false }));
    }
    if (request.method === "PATCH" && url.pathname === `/v1/license-keys/${LICENSE_ID}`) {
      const body = await request.json();
      patchBodies.push(body);
      const expectedLimit = quantity * 2;
      return jsonResponse(licenseDocument({ activationLimit: expectedLimit }));
    }

    throw new Error(`Unexpected API request: ${request.method} ${url.pathname}`);
  });
}

interface RefundMockOptions {
  disabled?: boolean;
  patchBodies?: unknown[];
}

function refundApiMock(options: RefundMockOptions = {}) {
  const disabled = options.disabled ?? false;
  const patchBodies = options.patchBodies ?? [];

  return vi.fn<Fetcher>(async (input, init) => {
    const request = new Request(input, init);
    assertApiAuthorization(request);
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === `/v1/orders/${ORDER_ID}`) {
      return jsonResponse(orderDocument({ status: "refunded", refunded: true }));
    }
    if (request.method === "GET" && url.pathname === "/v1/order-items") {
      expect(url.searchParams.get("filter[order_id]")).toBe(String(ORDER_ID));
      expect(url.searchParams.get("filter[product_id]")).toBe(String(MACNU_PRODUCT_ID));
      return jsonResponse(pageDocument([orderItemDocument().data]));
    }
    if (request.method === "GET" && url.pathname === "/v1/license-keys") {
      expect(url.searchParams.get("filter[order_id]")).toBe(String(ORDER_ID));
      expect(url.searchParams.get("filter[store_id]")).toBe(String(MACNU_STORE_ID));
      expect(url.searchParams.get("filter[product_id]")).toBe(String(MACNU_PRODUCT_ID));
      return jsonResponse(pageDocument([licenseDocument({ disabled }).data]));
    }
    if (request.method === "PATCH" && url.pathname === `/v1/license-keys/${LICENSE_ID}`) {
      const body = await request.json();
      patchBodies.push(body);
      return jsonResponse(licenseDocument({ disabled: true }));
    }

    throw new Error(`Unexpected API request: ${request.method} ${url.pathname}`);
  });
}

async function signedRequest(payload: unknown): Promise<Request> {
  const rawBody = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)),
  );
  const signature = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature": signature,
    },
    body: rawBody,
  });
}

function licenseCreatedPayload() {
  return {
    meta: { event_name: "license_key_created" },
    data: {
      type: "license-keys",
      id: LICENSE_ID,
      attributes: {
        store_id: MACNU_STORE_ID,
        order_id: ORDER_ID,
        order_item_id: ORDER_ITEM_ID,
        product_id: MACNU_PRODUCT_ID,
      },
    },
  };
}

function orderRefundedPayload(
  options: { status?: string; refunded?: boolean; testMode?: boolean } = {},
) {
  return {
    meta: { event_name: "order_refunded" },
    data: {
      type: "orders",
      id: String(ORDER_ID),
      attributes: {
        store_id: MACNU_STORE_ID,
        status: options.status ?? "refunded",
        refunded: options.refunded ?? true,
        test_mode: options.testMode ?? false,
      },
    },
  };
}

function licenseDocument(
  options: { activationLimit?: number; disabled?: boolean } = {},
) {
  return {
    data: {
      type: "license-keys",
      id: LICENSE_ID,
      attributes: {
        store_id: MACNU_STORE_ID,
        order_id: ORDER_ID,
        order_item_id: ORDER_ITEM_ID,
        product_id: MACNU_PRODUCT_ID,
        activation_limit: options.activationLimit ?? 2,
        disabled: options.disabled ? 1 : 0,
      },
    },
  };
}

function orderItemDocument(
  options: { productId?: number; variantId?: number; quantity?: number } = {},
) {
  return {
    data: {
      type: "order-items",
      id: String(ORDER_ITEM_ID),
      attributes: {
        order_id: ORDER_ID,
        product_id: options.productId ?? MACNU_PRODUCT_ID,
        variant_id: options.variantId ?? MACNU_BUSINESS_VARIANT_ID,
        quantity: options.quantity ?? 1,
      },
    },
  };
}

function orderDocument(
  options: {
    status?: string;
    refunded?: boolean;
    testMode?: boolean;
  } = {},
) {
  return {
    data: {
      type: "orders",
      id: String(ORDER_ID),
      attributes: {
        store_id: MACNU_STORE_ID,
        status: options.status ?? "paid",
        refunded: options.refunded ?? false,
        test_mode: options.testMode ?? false,
      },
    },
  };
}

function pageDocument(data: unknown[]) {
  return {
    meta: {
      page: {
        currentPage: 1,
        lastPage: 1,
      },
    },
    data,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function assertApiAuthorization(request: Request): void {
  expect(request.headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
  expect(request.headers.get("Accept")).toBe("application/vnd.api+json");
  expect(request.headers.get("Content-Type")).toBe("application/vnd.api+json");
}
