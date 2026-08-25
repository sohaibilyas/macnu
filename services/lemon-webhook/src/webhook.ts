import { SafeError } from "./errors";
import {
  expectBoolean,
  expectObject,
  expectPositiveInteger,
  expectString,
  parseJson,
  type JsonObject,
} from "./json";

const RESOURCE_ID_PATTERN = /^[1-9]\d*$/;

export interface WebhookEnvelope {
  eventName: string;
  payload: JsonObject;
}

export interface LicenseCreatedEvent {
  licenseId: string;
  storeId: number;
  orderId: number;
  orderItemId: number;
  productId: number;
}

export interface OrderRefundedEvent {
  orderId: string;
  storeId: number;
  status: string;
  refunded: boolean;
  testMode: boolean;
}

export function parseEnvelope(rawBody: Uint8Array): WebhookEnvelope {
  const payload = expectObject(parseJson(rawBody, 400, "invalid_json"));
  const meta = expectObject(payload.meta);
  const eventName = expectString(meta.event_name, 400, "invalid_payload");

  return { eventName, payload };
}

export function parseLicenseCreatedEvent(payload: JsonObject): LicenseCreatedEvent {
  const data = expectObject(payload.data);
  if (data.type !== "license-keys") {
    throw new SafeError(400, "invalid_payload");
  }

  const attributes = expectObject(data.attributes);

  return {
    licenseId: expectString(data.id, 400, "invalid_payload", RESOURCE_ID_PATTERN),
    storeId: expectPositiveInteger(attributes.store_id, 400, "invalid_payload"),
    orderId: expectPositiveInteger(attributes.order_id, 400, "invalid_payload"),
    orderItemId: expectPositiveInteger(attributes.order_item_id, 400, "invalid_payload"),
    productId: expectPositiveInteger(attributes.product_id, 400, "invalid_payload"),
  };
}

export function parseOrderRefundedEvent(payload: JsonObject): OrderRefundedEvent {
  const data = expectObject(payload.data);
  if (data.type !== "orders") {
    throw new SafeError(400, "invalid_payload");
  }

  const attributes = expectObject(data.attributes);

  return {
    orderId: expectString(data.id, 400, "invalid_payload", RESOURCE_ID_PATTERN),
    storeId: expectPositiveInteger(attributes.store_id, 400, "invalid_payload"),
    status: expectString(attributes.status, 400, "invalid_payload"),
    refunded: expectBoolean(attributes.refunded, 400, "invalid_payload"),
    testMode: expectBoolean(attributes.test_mode, 400, "invalid_payload"),
  };
}

export async function verifyWebhookSignature(
  rawBody: Uint8Array,
  providedSignature: string | null,
  secret: string,
): Promise<boolean> {
  if (providedSignature === null || !/^[a-fA-F0-9]{64}$/.test(providedSignature)) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const provided = hexToBytes(providedSignature);

  return crypto.subtle.timingSafeEqual(digest, provided);
}

function hexToBytes(hex: string): Uint8Array {
  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}
