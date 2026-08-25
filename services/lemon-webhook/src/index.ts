import {
  DEVICES_PER_SEAT,
  HEALTH_PATH,
  MACNU_BUSINESS_VARIANT_ID,
  MACNU_PERSONAL_VARIANT_ID,
  MACNU_PRODUCT_ID,
  MACNU_STORE_ID,
  MAX_WEBHOOK_BODY_BYTES,
  WEBHOOK_PATH,
} from "./constants";
import { asSafeError, SafeError } from "./errors";
import { readRequestBody } from "./json";
import {
  LemonApi,
  type Fetcher,
  type LicenseResource,
  type OrderItemResource,
} from "./lemon-api";
import {
  parseEnvelope,
  parseLicenseCreatedEvent,
  parseOrderRefundedEvent,
  verifyWebhookSignature,
  type LicenseCreatedEvent,
  type OrderRefundedEvent,
} from "./webhook";

interface ProcessResult {
  outcome: string;
  changed: number;
}

export async function handleRequest(
  request: Request,
  env: Env,
  fetcher: Fetcher = fetch,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);

  if (url.pathname === HEALTH_PATH) {
    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, requestId, {
        Allow: "GET",
      });
    }
    return jsonResponse({ ok: true, service: "macnu-lemon-webhook" }, 200, requestId);
  }

  if (url.pathname !== WEBHOOK_PATH) {
    return jsonResponse({ ok: false, error: "not_found" }, 404, requestId);
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, requestId, {
      Allow: "POST",
    });
  }

  try {
    assertRuntimeConfiguration(env);
    assertJsonContentType(request);

    const rawBody = await readRequestBody(request, MAX_WEBHOOK_BODY_BYTES);
    const signatureValid = await verifyWebhookSignature(
      rawBody,
      request.headers.get("x-signature"),
      env.LEMON_WEBHOOK_SECRET,
    );
    if (!signatureValid) {
      throw new SafeError(401, "invalid_signature");
    }

    const envelope = parseEnvelope(rawBody);
    const api = new LemonApi(env.LEMON_API_KEY, fetcher);
    const result = await processVerifiedWebhook(envelope.eventName, envelope.payload, api);

    logProcessed(requestId, result.outcome, result.changed);
    return jsonResponse(
      { ok: true, status: result.outcome, changed: result.changed },
      200,
      requestId,
    );
  } catch (error) {
    const safeError = asSafeError(error);
    logFailure(requestId, safeError);
    return jsonResponse(
      { ok: false, error: safeError.code },
      safeError.status,
      requestId,
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

async function processVerifiedWebhook(
  eventName: string,
  payload: Record<string, unknown>,
  api: LemonApi,
): Promise<ProcessResult> {
  if (eventName === "license_key_created") {
    return processLicenseCreated(parseLicenseCreatedEvent(payload), api);
  }

  if (eventName === "order_refunded") {
    return processOrderRefunded(parseOrderRefundedEvent(payload), api);
  }

  return { outcome: "ignored_event", changed: 0 };
}

async function processLicenseCreated(
  event: LicenseCreatedEvent,
  api: LemonApi,
): Promise<ProcessResult> {
  if (event.storeId !== MACNU_STORE_ID || event.productId !== MACNU_PRODUCT_ID) {
    return { outcome: "ignored_product", changed: 0 };
  }

  const license = await api.getLicense(event.licenseId);
  assertLicenseMatchesCreationEvent(license, event);

  const [orderItem, order] = await Promise.all([
    api.getOrderItem(event.orderItemId),
    api.getOrder(event.orderId),
  ]);

  if (
    orderItem.orderId !== event.orderId ||
    orderItem.productId !== MACNU_PRODUCT_ID ||
    order.id !== String(event.orderId) ||
    order.storeId !== MACNU_STORE_ID
  ) {
    throw new SafeError(409, "resource_mismatch");
  }

  if (order.testMode) {
    return { outcome: "ignored_test_mode", changed: 0 };
  }

  if (order.status !== "paid") {
    return { outcome: "ignored_order_status", changed: 0 };
  }

  if (orderItem.variantId === MACNU_PERSONAL_VARIANT_ID) {
    return { outcome: "personal_unchanged", changed: 0 };
  }

  if (orderItem.variantId !== MACNU_BUSINESS_VARIANT_ID) {
    return { outcome: "ignored_variant", changed: 0 };
  }

  if (orderItem.quantity > Number.MAX_SAFE_INTEGER / DEVICES_PER_SEAT) {
    throw new SafeError(502, "upstream_invalid_quantity");
  }
  const desiredActivationLimit = orderItem.quantity * DEVICES_PER_SEAT;

  if (license.activationLimit === desiredActivationLimit) {
    return { outcome: "already_configured", changed: 0 };
  }

  const updated = await api.setActivationLimit(license.id, desiredActivationLimit);
  assertSameLicense(license, updated);
  if (updated.activationLimit !== desiredActivationLimit) {
    throw new SafeError(502, "upstream_state_not_applied");
  }

  return { outcome: "business_limit_updated", changed: 1 };
}

async function processOrderRefunded(
  event: OrderRefundedEvent,
  api: LemonApi,
): Promise<ProcessResult> {
  if (event.storeId !== MACNU_STORE_ID) {
    return { outcome: "ignored_store", changed: 0 };
  }

  if (event.testMode) {
    return { outcome: "ignored_test_mode", changed: 0 };
  }

  if (!event.refunded || event.status !== "refunded") {
    return { outcome: "ignored_partial_refund", changed: 0 };
  }

  const order = await api.getOrder(event.orderId);
  if (order.storeId !== MACNU_STORE_ID) {
    throw new SafeError(409, "resource_mismatch");
  }
  if (order.testMode) {
    return { outcome: "ignored_test_mode", changed: 0 };
  }
  if (!order.refunded || order.status !== "refunded") {
    throw new SafeError(503, "upstream_not_ready");
  }

  const orderItems = await api.listOrderItemsForOrder(event.orderId, MACNU_PRODUCT_ID);
  if (orderItems.length === 0) {
    return { outcome: "ignored_product", changed: 0 };
  }

  const orderItemIds = validateRefundOrderItems(event.orderId, orderItems);
  const licenses = await api.listLicensesForOrder(
    event.orderId,
    MACNU_STORE_ID,
    MACNU_PRODUCT_ID,
  );
  if (licenses.length === 0) {
    throw new SafeError(503, "upstream_not_ready");
  }

  let disabledCount = 0;
  for (const license of licenses) {
    if (
      license.storeId !== MACNU_STORE_ID ||
      license.productId !== MACNU_PRODUCT_ID ||
      String(license.orderId) !== event.orderId ||
      !orderItemIds.has(String(license.orderItemId))
    ) {
      throw new SafeError(409, "resource_mismatch");
    }

    if (license.disabled) {
      continue;
    }

    const updated = await api.disableLicense(license.id);
    assertSameLicense(license, updated);
    if (!updated.disabled) {
      throw new SafeError(502, "upstream_state_not_applied");
    }
    disabledCount += 1;
  }

  return {
    outcome: disabledCount === 0 ? "refund_already_disabled" : "refund_licenses_disabled",
    changed: disabledCount,
  };
}

function validateRefundOrderItems(
  orderId: string,
  orderItems: OrderItemResource[],
): Set<string> {
  const ids = new Set<string>();

  for (const orderItem of orderItems) {
    if (
      String(orderItem.orderId) !== orderId ||
      orderItem.productId !== MACNU_PRODUCT_ID ||
      (orderItem.variantId !== MACNU_PERSONAL_VARIANT_ID &&
        orderItem.variantId !== MACNU_BUSINESS_VARIANT_ID)
    ) {
      throw new SafeError(409, "resource_mismatch");
    }
    ids.add(orderItem.id);
  }

  return ids;
}

function assertLicenseMatchesCreationEvent(
  license: LicenseResource,
  event: LicenseCreatedEvent,
): void {
  if (
    license.id !== event.licenseId ||
    license.storeId !== MACNU_STORE_ID ||
    license.orderId !== event.orderId ||
    license.orderItemId !== event.orderItemId ||
    license.productId !== MACNU_PRODUCT_ID
  ) {
    throw new SafeError(409, "resource_mismatch");
  }
}

function assertSameLicense(before: LicenseResource, after: LicenseResource): void {
  if (
    before.id !== after.id ||
    before.storeId !== after.storeId ||
    before.orderId !== after.orderId ||
    before.orderItemId !== after.orderItemId ||
    before.productId !== after.productId
  ) {
    throw new SafeError(502, "upstream_resource_mismatch");
  }
}

function assertRuntimeConfiguration(env: Env): void {
  if (
    typeof env.LEMON_WEBHOOK_SECRET !== "string" ||
    env.LEMON_WEBHOOK_SECRET.length < 6 ||
    typeof env.LEMON_API_KEY !== "string" ||
    env.LEMON_API_KEY.length === 0
  ) {
    throw new SafeError(500, "missing_configuration");
  }
}

function assertJsonContentType(request: Request): void {
  const contentType = request.headers.get("content-type");
  if (contentType === null || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new SafeError(415, "unsupported_media_type");
  }
}

function jsonResponse(
  payload: Record<string, unknown>,
  status: number,
  requestId: string,
  additionalHeaders?: Record<string, string>,
): Response {
  const headers = new Headers(additionalHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Request-Id", requestId);

  return new Response(JSON.stringify(payload), { status, headers });
}

function logProcessed(requestId: string, outcome: string, changed: number): void {
  console.log(
    JSON.stringify({
      level: "info",
      event: "webhook_processed",
      request_id: requestId,
      outcome,
      changed,
    }),
  );
}

function logFailure(requestId: string, error: SafeError): void {
  console.error(
    JSON.stringify({
      level: "error",
      event: "webhook_failed",
      request_id: requestId,
      code: error.code,
      status: error.status,
    }),
  );
}
