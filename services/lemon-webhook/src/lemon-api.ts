import {
  LEMON_API_BASE_URL,
  LICENSE_LIST_PAGE_SIZE,
  MAX_LICENSE_LIST_PAGES,
  MAX_UPSTREAM_BODY_BYTES,
  UPSTREAM_TIMEOUT_MS,
} from "./constants";
import { SafeError } from "./errors";
import {
  expectArray,
  expectBoolean,
  expectBooleanLike,
  expectNullableNonNegativeInteger,
  expectPositiveInteger,
  expectString,
  isJsonObject,
  readResponseJson,
  type JsonObject,
} from "./json";

const RESOURCE_ID_PATTERN = /^[1-9]\d*$/;
const JSON_API_MEDIA_TYPE = "application/vnd.api+json";

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface LicenseResource {
  id: string;
  storeId: number;
  orderId: number;
  orderItemId: number;
  productId: number;
  activationLimit: number | null;
  disabled: boolean;
}

export interface OrderItemResource {
  id: string;
  orderId: number;
  productId: number;
  variantId: number;
  quantity: number;
}

export interface OrderResource {
  id: string;
  storeId: number;
  status: string;
  refunded: boolean;
  testMode: boolean;
}

type LicenseUpdate =
  | { activation_limit: number }
  | { disabled: true };

interface LicensePage {
  currentPage: number;
  lastPage: number;
  licenses: LicenseResource[];
}

interface OrderItemPage {
  currentPage: number;
  lastPage: number;
  orderItems: OrderItemResource[];
}

export class LemonApi {
  readonly #apiKey: string;
  readonly #fetcher: Fetcher;

  constructor(apiKey: string, fetcher: Fetcher) {
    this.#apiKey = apiKey;
    this.#fetcher = fetcher;
  }

  async getLicense(licenseId: string): Promise<LicenseResource> {
    assertResourceId(licenseId);
    const payload = await this.#requestJson(`/license-keys/${licenseId}`, "GET");
    return parseLicenseDocument(payload, licenseId);
  }

  async getOrderItem(orderItemId: number): Promise<OrderItemResource> {
    const payload = await this.#requestJson(`/order-items/${orderItemId}`, "GET");
    return parseOrderItemDocument(payload, String(orderItemId));
  }

  async getOrder(orderId: number | string): Promise<OrderResource> {
    const normalizedId = String(orderId);
    assertResourceId(normalizedId);
    const payload = await this.#requestJson(`/orders/${normalizedId}`, "GET");
    return parseOrderDocument(payload, normalizedId);
  }

  async listLicensesForOrder(
    orderId: string,
    storeId: number,
    productId: number,
  ): Promise<LicenseResource[]> {
    assertResourceId(orderId);

    const licenses: LicenseResource[] = [];
    const seenIds = new Set<string>();
    let pageNumber = 1;

    while (true) {
      const parameters = new URLSearchParams({
        "filter[order_id]": orderId,
        "filter[store_id]": String(storeId),
        "filter[product_id]": String(productId),
        "page[number]": String(pageNumber),
        "page[size]": String(LICENSE_LIST_PAGE_SIZE),
      });
      const payload = await this.#requestJson(`/license-keys?${parameters.toString()}`, "GET");
      const page = parseLicensePage(payload);

      if (
        page.currentPage !== pageNumber ||
        page.lastPage < page.currentPage ||
        page.lastPage > MAX_LICENSE_LIST_PAGES
      ) {
        throw new SafeError(502, "upstream_invalid_pagination");
      }

      for (const license of page.licenses) {
        if (seenIds.has(license.id)) {
          throw new SafeError(502, "upstream_duplicate_resource");
        }
        seenIds.add(license.id);
        licenses.push(license);
      }

      if (pageNumber >= page.lastPage) {
        break;
      }
      pageNumber += 1;
    }

    return licenses;
  }

  async listOrderItemsForOrder(
    orderId: string,
    productId: number,
  ): Promise<OrderItemResource[]> {
    assertResourceId(orderId);

    const orderItems: OrderItemResource[] = [];
    const seenIds = new Set<string>();
    let pageNumber = 1;

    while (true) {
      const parameters = new URLSearchParams({
        "filter[order_id]": orderId,
        "filter[product_id]": String(productId),
        "page[number]": String(pageNumber),
        "page[size]": String(LICENSE_LIST_PAGE_SIZE),
      });
      const payload = await this.#requestJson(`/order-items?${parameters.toString()}`, "GET");
      const page = parseOrderItemPage(payload);

      if (
        page.currentPage !== pageNumber ||
        page.lastPage < page.currentPage ||
        page.lastPage > MAX_LICENSE_LIST_PAGES
      ) {
        throw new SafeError(502, "upstream_invalid_pagination");
      }

      for (const orderItem of page.orderItems) {
        if (seenIds.has(orderItem.id)) {
          throw new SafeError(502, "upstream_duplicate_resource");
        }
        seenIds.add(orderItem.id);
        orderItems.push(orderItem);
      }

      if (pageNumber >= page.lastPage) {
        break;
      }
      pageNumber += 1;
    }

    return orderItems;
  }

  async setActivationLimit(licenseId: string, activationLimit: number): Promise<LicenseResource> {
    return this.#updateLicense(licenseId, { activation_limit: activationLimit });
  }

  async disableLicense(licenseId: string): Promise<LicenseResource> {
    return this.#updateLicense(licenseId, { disabled: true });
  }

  async #updateLicense(licenseId: string, attributes: LicenseUpdate): Promise<LicenseResource> {
    assertResourceId(licenseId);
    const payload = await this.#requestJson(`/license-keys/${licenseId}`, "PATCH", {
      data: {
        type: "license-keys",
        id: licenseId,
        attributes,
      },
    });
    return parseLicenseDocument(payload, licenseId);
  }

  async #requestJson(path: string, method: "GET" | "PATCH", body?: JsonObject): Promise<unknown> {
    let response: Response;

    try {
      response = await this.#fetcher(`${LEMON_API_BASE_URL}${path}`, {
        method,
        headers: {
          Accept: JSON_API_MEDIA_TYPE,
          "Content-Type": JSON_API_MEDIA_TYPE,
          Authorization: `Bearer ${this.#apiKey}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      throw new SafeError(503, "upstream_unavailable");
    }

    if (!response.ok) {
      if (response.status === 404 || response.status === 408 || response.status === 429) {
        throw new SafeError(503, "upstream_not_ready");
      }
      if (response.status >= 500) {
        throw new SafeError(503, "upstream_unavailable");
      }
      throw new SafeError(502, "upstream_rejected_request");
    }

    return readResponseJson(response, MAX_UPSTREAM_BODY_BYTES);
  }
}

function parseLicenseDocument(value: unknown, expectedId: string): LicenseResource {
  const document = expectApiObject(value);
  return parseLicenseResource(document.data, expectedId);
}

function parseLicensePage(value: unknown): LicensePage {
  const document = expectApiObject(value);
  const meta = expectApiObject(document.meta);
  const page = expectApiObject(meta.page);
  const currentPage = expectPositiveInteger(
    page.currentPage,
    502,
    "upstream_invalid_pagination",
  );
  const lastPage = expectPositiveInteger(page.lastPage, 502, "upstream_invalid_pagination");
  const data = expectArray(document.data, "upstream_invalid_response");

  return {
    currentPage,
    lastPage,
    licenses: data.map((entry) => parseLicenseResource(entry)),
  };
}

function parseOrderItemPage(value: unknown): OrderItemPage {
  const document = expectApiObject(value);
  const meta = expectApiObject(document.meta);
  const page = expectApiObject(meta.page);
  const currentPage = expectPositiveInteger(
    page.currentPage,
    502,
    "upstream_invalid_pagination",
  );
  const lastPage = expectPositiveInteger(page.lastPage, 502, "upstream_invalid_pagination");
  const data = expectArray(document.data, "upstream_invalid_response");

  return {
    currentPage,
    lastPage,
    orderItems: data.map((entry) => parseOrderItemResource(entry)),
  };
}

function parseLicenseResource(value: unknown, expectedId?: string): LicenseResource {
  const resource = expectApiObject(value);
  if (resource.type !== "license-keys") {
    throw new SafeError(502, "upstream_invalid_response");
  }

  const id = expectString(
    resource.id,
    502,
    "upstream_invalid_response",
    RESOURCE_ID_PATTERN,
  );
  if (expectedId !== undefined && id !== expectedId) {
    throw new SafeError(502, "upstream_resource_mismatch");
  }

  const attributes = expectApiObject(resource.attributes);

  return {
    id,
    storeId: expectPositiveInteger(attributes.store_id, 502, "upstream_invalid_response"),
    orderId: expectPositiveInteger(attributes.order_id, 502, "upstream_invalid_response"),
    orderItemId: expectPositiveInteger(
      attributes.order_item_id,
      502,
      "upstream_invalid_response",
    ),
    productId: expectPositiveInteger(
      attributes.product_id,
      502,
      "upstream_invalid_response",
    ),
    activationLimit: expectNullableNonNegativeInteger(
      attributes.activation_limit,
      502,
      "upstream_invalid_response",
    ),
    disabled: expectBooleanLike(attributes.disabled, 502, "upstream_invalid_response"),
  };
}

function parseOrderItemDocument(value: unknown, expectedId: string): OrderItemResource {
  const document = expectApiObject(value);
  return parseOrderItemResource(document.data, expectedId);
}

function parseOrderItemResource(value: unknown, expectedId?: string): OrderItemResource {
  const resource = expectApiObject(value);
  if (resource.type !== "order-items") {
    throw new SafeError(502, "upstream_resource_mismatch");
  }

  const id = expectString(
    resource.id,
    502,
    "upstream_invalid_response",
    RESOURCE_ID_PATTERN,
  );
  if (expectedId !== undefined && id !== expectedId) {
    throw new SafeError(502, "upstream_resource_mismatch");
  }

  const attributes = expectApiObject(resource.attributes);

  return {
    id,
    orderId: expectPositiveInteger(attributes.order_id, 502, "upstream_invalid_response"),
    productId: expectPositiveInteger(attributes.product_id, 502, "upstream_invalid_response"),
    variantId: expectPositiveInteger(attributes.variant_id, 502, "upstream_invalid_response"),
    quantity: expectPositiveInteger(attributes.quantity, 502, "upstream_invalid_response"),
  };
}

function parseOrderDocument(value: unknown, expectedId: string): OrderResource {
  const document = expectApiObject(value);
  const resource = expectApiObject(document.data);
  if (resource.type !== "orders" || resource.id !== expectedId) {
    throw new SafeError(502, "upstream_resource_mismatch");
  }

  const attributes = expectApiObject(resource.attributes);

  return {
    id: expectedId,
    storeId: expectPositiveInteger(attributes.store_id, 502, "upstream_invalid_response"),
    status: expectString(attributes.status, 502, "upstream_invalid_response"),
    refunded: expectBoolean(attributes.refunded, 502, "upstream_invalid_response"),
    testMode: expectBoolean(attributes.test_mode, 502, "upstream_invalid_response"),
  };
}

function expectApiObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new SafeError(502, "upstream_invalid_response");
  }
  return value;
}

function assertResourceId(value: string): void {
  if (!RESOURCE_ID_PATTERN.test(value)) {
    throw new SafeError(400, "invalid_resource_id");
  }
}
