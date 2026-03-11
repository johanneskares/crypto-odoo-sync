import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import { Data, Effect } from "effect";

export class FrankfurterApiError extends Data.TaggedError("FrankfurterApiError")<{
  status: number;
  message: string;
}> {}

export interface ExchangeRate {
  date: string;
  rate: number;
}

export interface FetchRatesParams {
  base: string;
  symbol: string;
  fromDate: string;
  toDate: string;
}

interface TimeSeriesResponse {
  base: string;
  start_date: string;
  end_date: string;
  rates: Record<string, Record<string, number>>;
}

const BASE_URL = "https://api.frankfurter.dev/v1";

export const fetchTimeSeriesRates = (
  params: FetchRatesParams,
): Effect.Effect<ExchangeRate[], FrankfurterApiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = `${BASE_URL}/${params.fromDate}..${params.toDate}?base=${encodeURIComponent(params.base)}&symbols=${encodeURIComponent(params.symbol)}`;
    const request = HttpClientRequest.get(url);
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new FrankfurterApiError({ status: 0, message: error.message }),
      ),
    );

    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(
        Effect.orElseSucceed(() => ""),
      );
      return yield* Effect.fail(
        new FrankfurterApiError({
          status: response.status,
          message: `Frankfurter API error (HTTP ${response.status}): ${body.slice(0, 200)}`,
        }),
      );
    }

    const body = yield* response.json.pipe(
      Effect.mapError(
        (error) =>
          new FrankfurterApiError({
            status: response.status,
            message: `Failed to parse Frankfurter response: ${error.message}`,
          }),
      ),
    );

    const data = body as TimeSeriesResponse;
    const rates: ExchangeRate[] = [];
    const upperSymbol = params.symbol.toUpperCase();

    for (const [date, currencyRates] of Object.entries(data.rates)) {
      const rate = currencyRates[upperSymbol];
      if (rate !== undefined) {
        rates.push({ date, rate });
      }
    }

    rates.sort((a, b) => a.date.localeCompare(b.date));
    return rates;
  });

export class FrankfurterService extends Effect.Service<FrankfurterService>()(
  "FrankfurterService",
  {
    succeed: {
      fetchTimeSeriesRates: (params: FetchRatesParams) =>
        fetchTimeSeriesRates(params),
    },
    accessors: true,
  },
) {}
