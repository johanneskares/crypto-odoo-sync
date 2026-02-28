import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import type * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { Data, Effect } from "effect";

const TRAILING_SLASH = /\/$/;

type OdooPrimitive = string | number | boolean | null;
export type OdooValue = OdooPrimitive | OdooValue[] | { [key: string]: OdooValue };
export type OdooObject = Record<string, OdooValue>;
export type OdooDomainCondition = readonly [field: string, operator: string, value: OdooValue];
export type OdooDomainTerm = OdooDomainCondition | "&" | "|" | "!";
export type OdooDomain = ReadonlyArray<OdooDomainTerm>;

export class OdooApiError extends Data.TaggedError("OdooApiError")<{
  status: number;
  name: string;
  message: string;
}> {}

export interface OdooClientConfig {
  apiKey: string;
  baseUrl: string;
}

export interface OdooJournalRecord {
  id: number;
  name: string;
  type: string;
  company_id: false | number | [number, string];
  currency_id: false | number | [number, string];
}

export interface OdooCompanyRecord {
  id: number;
  name: string;
}

interface OdooErrorPayload {
  name?: string;
  message?: string;
  error?: {
    message?: string;
    data?: {
      name?: string;
      message?: string;
    };
  };
}

type OdooEffect<A> = Effect.Effect<A, OdooApiError, HttpClient.HttpClient>;

const parseError = (response: HttpClientResponse.HttpClientResponse): OdooEffect<{ name: string; message: string }> =>
  response.text.pipe(
    Effect.mapError(
      (error) =>
        new OdooApiError({
          status: response.status,
          name: error._tag,
          message: error.message,
        })
    ),
    Effect.map((text) => {
      if (!text) {
        return {
          name: "Error",
          message: `HTTP ${response.status}`,
        };
      }

      try {
        const payload = JSON.parse(text) as OdooErrorPayload;
        return {
          name: payload.name ?? payload.error?.data?.name ?? "Error",
          message:
            payload.message ?? payload.error?.data?.message ?? payload.error?.message ?? `HTTP ${response.status}`,
        };
      } catch {
        return {
          name: "Error",
          message: text.slice(0, 200),
        };
      }
    })
  );

const post = <T>(
  config: OdooClientConfig,
  model: string,
  method: string,
  body: object
): OdooEffect<T> =>
  Effect.gen(function* () {
    const url = `${config.baseUrl.replace(TRAILING_SLASH, "")}/json/2/${model}/${method}`;
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bearerToken(config.apiKey),
      HttpClientRequest.bodyUnsafeJson(body)
    );
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new OdooApiError({
            status: 0,
            name: error._tag,
            message: error.message,
          })
      )
    );

    if (response.status < 200 || response.status >= 300) {
      const parsed = yield* parseError(response);
      return yield* Effect.fail(
        new OdooApiError({
          status: response.status,
          name: parsed.name,
          message: `${parsed.message} [${method} ${model}, HTTP ${response.status}]`,
        })
      );
    }

    return yield* response.json.pipe(
      Effect.map((json) => json as T),
      Effect.mapError(
        (error) =>
          new OdooApiError({
            status: response.status,
            name: error._tag,
            message: error.message,
          })
      )
    );
  });

export interface OdooSearchReadParams {
  domain: OdooDomain;
  fields: string[];
  limit?: number;
}

export interface OdooClient {
  create: (model: string, values: OdooObject) => OdooEffect<number>;
  createBatch: (model: string, valsList: OdooObject[]) => OdooEffect<readonly number[]>;
  searchRead: <T>(
    model: string,
    params: OdooSearchReadParams
  ) => OdooEffect<readonly T[]>;
}

export interface CreateJournalParams {
  name: string;
  code: string;
  companyId?: number;
  currencyCode?: string;
}

export interface FetchExistingImportIdsOptions {
  chunkSize?: number;
  companyId?: number;
  journalId?: number;
}

export const makeOdooClient = (config: OdooClientConfig): OdooClient => ({
  create: (model, values) =>
    post<number[]>(config, model, "create", {
      vals_list: [values],
    }).pipe(Effect.map((ids) => ids[0] ?? 0)),

  createBatch: (model, valsList) =>
    post<number[]>(config, model, "create", {
      vals_list: valsList,
    }).pipe(Effect.map((ids): readonly number[] => ids)),

  searchRead: <T>(model: string, params: OdooSearchReadParams) =>
    post<readonly T[]>(config, model, "search_read", params),
});

export const listCompanies = (client: OdooClient) =>
  client.searchRead<OdooCompanyRecord>("res.company", {
    domain: [],
    fields: ["id", "name"],
    limit: 500,
  });

export const listJournals = (client: OdooClient, companyId?: number) =>
  client.searchRead<OdooJournalRecord>("account.journal", {
    domain: companyId === undefined ? [] : [["company_id", "=", companyId]],
    fields: ["id", "name", "type", "company_id", "currency_id"],
    limit: 500,
  });

export const resolveCurrencyId = (client: OdooClient, currencyCode: string) =>
  client
    .searchRead<{ id: number; name: string }>("res.currency", {
      domain: [["name", "=", currencyCode.toUpperCase()]],
      fields: ["id", "name"],
      limit: 1,
    })
    .pipe(
      Effect.flatMap((rows) => {
        const first = rows[0];
        if (!first) {
          return Effect.fail(
            new OdooApiError({
              status: 404,
              name: "CurrencyNotFound",
              message: `Currency ${currencyCode.toUpperCase()} not found in Odoo`,
            })
          );
        }
        return Effect.succeed(first.id);
      })
    );

export const createJournal = (client: OdooClient, params: CreateJournalParams) =>
  Effect.gen(function* () {
    const maybeCurrencyId =
      params.currencyCode && params.currencyCode.trim().length > 0
        ? yield* resolveCurrencyId(client, params.currencyCode)
        : undefined;

    const journalId = yield* client.create("account.journal", {
      name: params.name,
      code: params.code,
      type: "bank",
      ...(params.companyId ? { company_id: params.companyId } : {}),
      ...(maybeCurrencyId ? { currency_id: maybeCurrencyId } : {}),
    });

    const [journal] = yield* client.searchRead<OdooJournalRecord>("account.journal", {
      domain: [["id", "=", journalId]],
      fields: ["id", "name", "type", "company_id", "currency_id"],
      limit: 1,
    });

    if (!journal) {
      return yield* Effect.fail(
        new OdooApiError({
          status: 404,
          name: "JournalNotFound",
          message: `Created journal ${journalId} could not be fetched`,
        })
      );
    }

    return journal;
  });

export const fetchExistingImportIds = (
  client: OdooClient,
  uniqueImportIds: readonly string[],
  options: FetchExistingImportIdsOptions = {}
): OdooEffect<Set<string>> =>
  Effect.gen(function* () {
    const chunkSize = options.chunkSize ?? 100;
    const existing = new Set<string>();

    for (let index = 0; index < uniqueImportIds.length; index += chunkSize) {
      const chunk = uniqueImportIds.slice(index, index + chunkSize);
      if (chunk.length === 0) {
        continue;
      }

      const domain: OdooDomainTerm[] = [["unique_import_id", "in", chunk]];
      if (options.companyId !== undefined) {
        domain.push(["company_id", "=", options.companyId]);
      }
      if (options.journalId !== undefined) {
        domain.push(["journal_id", "=", options.journalId]);
      }

      const rows = yield* client.searchRead<{ unique_import_id: string }>("account.bank.statement.line", {
        domain,
        fields: ["unique_import_id"],
        limit: chunk.length,
      });

      for (const row of rows) {
        existing.add(row.unique_import_id);
      }
    }

    return existing;
  });

export class OdooService extends Effect.Service<OdooService>()("OdooService", {
  succeed: {
    listCompanies: (config: OdooClientConfig) => listCompanies(makeOdooClient(config)),
    listJournals: (config: OdooClientConfig, companyId?: number) => listJournals(makeOdooClient(config), companyId),
    createJournal: (config: OdooClientConfig, params: CreateJournalParams) =>
      createJournal(makeOdooClient(config), params),
    fetchExistingImportIds: (
      config: OdooClientConfig,
      uniqueImportIds: readonly string[],
      options: FetchExistingImportIdsOptions = {}
    ) => fetchExistingImportIds(makeOdooClient(config), uniqueImportIds, options),
    createStatementLinesBatch: (
      config: OdooClientConfig,
      lines: ReadonlyArray<OdooObject>
    ) => makeOdooClient(config).createBatch("account.bank.statement.line", [...lines]),
  },
  accessors: true,
}) {}
