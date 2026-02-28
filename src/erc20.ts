import { Data, Effect, Schedule } from "effect";
import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  isAddress,
  type Address,
  type Hash,
} from "viem";

import { resolveAlchemyRpcUrl, resolveChainOption } from "./constants";

const BLOCK_SEARCH_LOG_EVERY_STEPS = 8;
const RPC_REQUEST_TIMEOUT = "30 seconds";
const RPC_RETRY_DELAY = "200 millis";
const RPC_RETRY_TIMES = 2;
const ALCHEMY_MAX_PAGE_SIZE = "0x3e8";
const ALCHEMY_TRANSFER_CATEGORY = ["erc20"] as const;

type AnyPublicClient = ReturnType<typeof createPublicClient>;
interface Erc20ReadClient {
  readContract: (parameters: {
    abi: typeof erc20Abi;
    address: Address;
    functionName: "decimals" | "symbol";
  }) => Promise<string | number | bigint>;
}
interface RpcRequestClient {
  request: (parameters: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
}

interface AlchemyGetAssetTransfersParams {
  category: typeof ALCHEMY_TRANSFER_CATEGORY;
  contractAddresses: readonly [Address];
  excludeZeroValue: boolean;
  fromAddress?: Address;
  fromBlock: string;
  maxCount: string;
  order: "asc" | "desc";
  pageKey?: string;
  toAddress?: Address;
  toBlock: string;
  withMetadata: true;
}

interface AlchemyAssetTransferMetadata {
  blockTimestamp?: string;
}

interface AlchemyAssetTransferRawContract {
  value?: string;
}

interface AlchemyAssetTransfer {
  blockNum?: string;
  from?: string;
  hash?: string;
  logIndex?: string | number;
  metadata?: AlchemyAssetTransferMetadata;
  rawContract?: AlchemyAssetTransferRawContract;
  to?: string;
  uniqueId?: string;
}

interface AlchemyGetAssetTransfersResponse {
  pageKey?: string;
  transfers?: AlchemyAssetTransfer[];
}

interface ParsedAssetTransfer {
  blockNumber: bigint;
  from: Address;
  logIndex: number;
  timestamp: number | undefined;
  to: Address;
  txHash: Hash;
  uniqueId: string;
  value: bigint;
}

const toErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const toHexBlock = (value: bigint): `0x${string}` => `0x${value.toString(16)}`;
const isHex = (value: string): boolean => /^0x[0-9a-f]+$/i.test(value);

const withRpcTimeoutAndRetry = <A>(
  effect: Effect.Effect<A, ChainError>,
  timeoutMessage: string
): Effect.Effect<A, ChainError> =>
  effect.pipe(
    Effect.timeoutFail({
      duration: RPC_REQUEST_TIMEOUT,
      onTimeout: () =>
        new ChainError({
          message: timeoutMessage,
        }),
    }),
    Effect.retry({
      schedule: Schedule.exponential(RPC_RETRY_DELAY),
      times: RPC_RETRY_TIMES,
    })
  );

const queryAssetTransfers = (
  client: AnyPublicClient,
  params: AlchemyGetAssetTransfersParams
): Promise<AlchemyGetAssetTransfersResponse> =>
  (client as RpcRequestClient)
    .request({
      method: "alchemy_getAssetTransfers",
      params: [params],
    })
    .then((response) => response as AlchemyGetAssetTransfersResponse);

export class ChainError extends Data.TaggedError("ChainError")<{
  message: string;
}> {}

export interface DateRange {
  fromDate: string;
  toDate: string;
}

export interface TransferRecord {
  amount: number;
  amountRaw: string;
  blockNumber: bigint;
  date: string;
  from: Address;
  logIndex: number;
  network: string;
  timestamp: number;
  to: Address;
  tokenAddress: Address;
  tokenSymbol: string;
  txHash: Hash;
  uniqueId: string;
}

const parseUtcDate = (date: string, endOfDay = false): Effect.Effect<number, ChainError> =>
  Effect.sync(() => {
    const normalized = date.trim();
    const suffix = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
    const timestampMs = Date.parse(`${normalized}${suffix}`);

    if (Number.isNaN(timestampMs)) {
      throw new ChainError({
        message: `Invalid date \"${date}\". Use YYYY-MM-DD format.`,
      });
    }

    return Math.floor(timestampMs / 1_000);
  });

const makeClient = (
  network: string,
  alchemyApiKey: string
): Effect.Effect<{ chainId: number; client: AnyPublicClient; networkKey: string; rpcUrl: string }, ChainError> =>
  Effect.sync(() => {
    const chainOption = resolveChainOption(network);
    if (!chainOption) {
      throw new ChainError({
        message: `Unsupported network \\\"${network}\\\". Pick a chain from setup again.`,
      });
    }

    const normalizedAlchemyApiKey = alchemyApiKey.trim();
    if (normalizedAlchemyApiKey.length === 0) {
      throw new ChainError({
        message: "Alchemy API key is required.",
      });
    }
    const rpcUrl = resolveAlchemyRpcUrl(network, normalizedAlchemyApiKey);

    if (!rpcUrl) {
      throw new ChainError({
        message: `No Alchemy RPC URL available for network \"${network}\".`,
      });
    }

    return {
      chainId: chainOption.chain.id,
      client: createPublicClient({
        chain: chainOption.chain,
        transport: http(rpcUrl),
      }),
      networkKey: chainOption.key,
      rpcUrl,
    };
  });

const fetchLatestBlock = (client: AnyPublicClient): Effect.Effect<{ number: bigint; timestamp: number }, ChainError> =>
  withRpcTimeoutAndRetry(
    Effect.promise(async () => {
      const latest = await client.getBlock({ blockTag: "latest" });
      return {
        number: latest.number,
        timestamp: Number(latest.timestamp),
      };
    }).pipe(
      Effect.catchAllDefect((error) =>
        Effect.fail(
          new ChainError({
            message: `Failed to load latest block: ${toErrorMessage(error)}`,
          })
        )
      )
    ),
    "Timed out loading latest block from RPC"
  );

const fetchBlockTimestamp = (
  client: AnyPublicClient,
  blockNumber: bigint
): Effect.Effect<number, ChainError> =>
  withRpcTimeoutAndRetry(
    Effect.promise(() => client.getBlock({ blockNumber })).pipe(
      Effect.map((block) => Number(block.timestamp)),
      Effect.catchAllDefect((error) =>
        Effect.fail(
          new ChainError({
            message: `Failed to load block ${blockNumber}: ${toErrorMessage(error)}`,
          })
        )
      )
    ),
    `Timed out loading block ${blockNumber} from RPC`
  );

const findBlockAtOrAfter = (
  client: AnyPublicClient,
  targetTimestamp: number,
  latestBlock: bigint,
  label: string
): Effect.Effect<bigint, ChainError> =>
  Effect.gen(function* () {
    let left = 0n;
    let right = latestBlock;
    let steps = 0;

    while (left < right) {
      steps += 1;
      if (steps === 1 || steps % BLOCK_SEARCH_LOG_EVERY_STEPS === 0) {
        yield* Effect.logDebug(`Resolving ${label}: step ${steps}, search range ${left}-${right}`);
      }

      const middle = (left + right) / 2n;
      const blockTimestamp = yield* fetchBlockTimestamp(client, middle);

      if (blockTimestamp < targetTimestamp) {
        left = middle + 1n;
      } else {
        right = middle;
      }
    }

    yield* Effect.logDebug(`Resolved ${label} at block ${left} after ${steps} step(s)`);
    return left;
  });

const fetchTokenMeta = (client: AnyPublicClient, tokenAddress: Address) => {
  const readClient = client as Erc20ReadClient;

  return Effect.all({
    decimals: withRpcTimeoutAndRetry(
      Effect.promise(() =>
        readClient.readContract({
          abi: erc20Abi,
          address: tokenAddress,
          functionName: "decimals",
        })
      ).pipe(
        Effect.map((value) => Number(value)),
        Effect.catchAllDefect((error) =>
          Effect.fail(
            new ChainError({
              message: `Could not read token decimals from ${tokenAddress}: ${toErrorMessage(error)}`,
            })
          )
        )
      ),
      `Timed out reading token decimals from ${tokenAddress}`
    ),
    symbol: withRpcTimeoutAndRetry(
      Effect.promise(() =>
        readClient.readContract({
          abi: erc20Abi,
          address: tokenAddress,
          functionName: "symbol",
        })
      ).pipe(
        Effect.map((value) => String(value)),
        Effect.catchAllDefect((error) =>
          Effect.fail(
            new ChainError({
              message: `Could not read token symbol from ${tokenAddress}: ${toErrorMessage(error)}`,
            })
          )
        )
      ),
      `Timed out reading token symbol from ${tokenAddress}`
    ),
  });
};

const fetchTransfers = (
  client: AnyPublicClient,
  tokenAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
  args?: { from?: Address; to?: Address },
  label = "transfers"
): Effect.Effect<AlchemyAssetTransfer[], ChainError> =>
  Effect.gen(function* () {
    if (fromBlock > toBlock) {
      return [] as AlchemyAssetTransfer[];
    }

    const requestBase = {
      category: ALCHEMY_TRANSFER_CATEGORY,
      contractAddresses: [tokenAddress] as const,
      excludeZeroValue: false,
      fromBlock: toHexBlock(fromBlock),
      maxCount: ALCHEMY_MAX_PAGE_SIZE,
      order: "asc" as const,
      toBlock: toHexBlock(toBlock),
      withMetadata: true as const,
      ...(args?.from ? { fromAddress: args.from } : {}),
      ...(args?.to ? { toAddress: args.to } : {}),
    } satisfies Omit<AlchemyGetAssetTransfersParams, "pageKey">;

    let pageKey: string | undefined;
    let page = 0;
    const transfers: AlchemyAssetTransfer[] = [];

    while (true) {
      page += 1;
      yield* Effect.logDebug(
        `Fetching ${label} via alchemy_getAssetTransfers: blocks ${fromBlock}-${toBlock}, page=${page}${pageKey ? `, pageKey=${pageKey}` : ""}`
      );

      const response = yield* withRpcTimeoutAndRetry(
        Effect.promise(() => queryAssetTransfers(client, { ...requestBase, ...(pageKey ? { pageKey } : {}) })).pipe(
          Effect.catchAllDefect((error) =>
            Effect.fail(
              new ChainError({
                message: `Failed to query ${label} transfers ${fromBlock}-${toBlock}: ${toErrorMessage(error)}`,
              })
            )
          )
        ),
        `Timed out querying ${label} transfers from Alchemy for block range ${fromBlock}-${toBlock}`
      );

      const pageTransfers = Array.isArray(response.transfers) ? response.transfers : [];
      transfers.push(...pageTransfers);

      const nextPageKey = response.pageKey?.trim();
      if (!nextPageKey) {
        break;
      }
      pageKey = nextPageKey;
    }

    return transfers;
  });

const fetchWalletTransfers = (
  client: AnyPublicClient,
  tokenAddress: Address,
  wallet: Address,
  fromBlock: bigint,
  toBlock: bigint
): Effect.Effect<AlchemyAssetTransfer[], ChainError> =>
  Effect.gen(function* () {
    yield* Effect.logDebug("Scanning incoming transfer logs...");
    const incoming = yield* fetchTransfers(client, tokenAddress, fromBlock, toBlock, { to: wallet }, "incoming");

    yield* Effect.logDebug("Scanning outgoing transfer logs...");
    const outgoing = yield* fetchTransfers(client, tokenAddress, fromBlock, toBlock, { from: wallet }, "outgoing");

    const deduped = new Map<string, AlchemyAssetTransfer>();
    for (const entry of [...incoming, ...outgoing]) {
      const txHash = (entry.hash ?? "").toLowerCase();
      const uniqueId = entry.uniqueId?.toLowerCase();
      const logIndexFromUniqueId = uniqueId?.split(":").at(-1);
      const logIndex = entry.logIndex ?? logIndexFromUniqueId;
      deduped.set(`${txHash}-${String(logIndex ?? uniqueId ?? "unknown")}`, entry);
    }

    return [...deduped.values()];
  });

const resolveBlockTimestamps = (client: AnyPublicClient, blockNumbers: readonly bigint[]) =>
  Effect.forEach(
    blockNumbers,
    (blockNumber) =>
      fetchBlockTimestamp(client, blockNumber).pipe(
        Effect.map((timestamp) => ({
          blockNumber,
          timestamp,
        }))
      ),
    { concurrency: 4 }
  );

export const assertAddress = (value: string, label = "address"): Effect.Effect<Address, ChainError> =>
  Effect.sync(() => {
    if (!isAddress(value)) {
      throw new ChainError({
        message: `Invalid ${label}: ${value}`,
      });
    }
    return value;
  });

export const getTransferRecords = (params: {
  network: string;
  tokenAddress: Address;
  fromDate: string;
  toDate: string;
  walletAddress: Address;
  alchemyApiKey: string;
}): Effect.Effect<readonly TransferRecord[], ChainError> =>
  Effect.gen(function* () {
    const fromTimestamp = yield* parseUtcDate(params.fromDate, false);
    const toTimestamp = yield* parseUtcDate(params.toDate, true);

    if (fromTimestamp > toTimestamp) {
      return yield* Effect.fail(
        new ChainError({
          message: "`from` date must be earlier than or equal to `to` date.",
        })
      );
    }

    const { chainId, client, networkKey, rpcUrl } = yield* makeClient(params.network, params.alchemyApiKey);
    yield* Effect.logDebug(`RPC client ready for network=${networkKey}, mode=alchemy, endpoint=${rpcUrl}`);

    yield* Effect.logDebug("Loading latest block...");
    const latestBlock = yield* fetchLatestBlock(client);

    yield* Effect.logDebug(
      `Latest block=${latestBlock.number} timestamp=${latestBlock.timestamp} (${new Date(latestBlock.timestamp * 1_000).toISOString()})`
    );

    yield* Effect.logDebug(`Resolving start block for ${params.fromDate}...`);
    const fromBlock = yield* findBlockAtOrAfter(client, fromTimestamp, latestBlock.number, `from=${params.fromDate}`);

    const toBlock =
      toTimestamp >= latestBlock.timestamp
        ? latestBlock.number
        : (yield* findBlockAtOrAfter(client, toTimestamp + 1, latestBlock.number, `to=${params.toDate}`)) - 1n;

    if (fromBlock > toBlock) {
      return [];
    }

    yield* Effect.logDebug(`Resolved block range ${fromBlock}-${toBlock}`);

    yield* Effect.logDebug(`Loading token metadata for ${params.tokenAddress}...`);
    const tokenMeta = yield* fetchTokenMeta(client, params.tokenAddress);
    yield* Effect.logDebug(`Token metadata: symbol=${tokenMeta.symbol}, decimals=${tokenMeta.decimals}`);

    const rawLogs = yield* fetchWalletTransfers(
      client,
      params.tokenAddress,
      params.walletAddress,
      fromBlock,
      toBlock
    );

    if (rawLogs.length === 0) {
      return [];
    }

    const parseLogIndex = (entry: AlchemyAssetTransfer, fallback: number): number => {
      const fromLogIndex = entry.logIndex;
      if (typeof fromLogIndex === "number" && Number.isInteger(fromLogIndex)) {
        return fromLogIndex;
      }
      if (typeof fromLogIndex === "string" && fromLogIndex.trim().length > 0) {
        const normalized = fromLogIndex.trim();
        const parsed = isHex(normalized)
          ? Number.parseInt(normalized.slice(2), 16)
          : Number.parseInt(normalized, 10);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }

      const fromUniqueId = entry.uniqueId?.split(":").at(-1)?.trim();
      if (fromUniqueId && fromUniqueId.length > 0) {
        const parsed = isHex(fromUniqueId)
          ? Number.parseInt(fromUniqueId.slice(2), 16)
          : Number.parseInt(fromUniqueId, 10);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }

      return fallback;
    };

    const parseTimestamp = (entry: AlchemyAssetTransfer): number | undefined => {
      const blockTimestamp = entry.metadata?.blockTimestamp;
      if (!blockTimestamp || blockTimestamp.trim().length === 0) {
        return undefined;
      }
      const parsed = Date.parse(blockTimestamp);
      if (Number.isNaN(parsed)) {
        return undefined;
      }
      return Math.floor(parsed / 1_000);
    };

    const parsedTransfers = rawLogs
      .map((entry, index) => {
        if (!entry.blockNum || !entry.hash || !entry.from || !entry.to || !entry.rawContract?.value) {
          return undefined;
        }
        if (!isAddress(entry.from) || !isAddress(entry.to)) {
          return undefined;
        }

        let blockNumber: bigint;
        try {
          blockNumber = BigInt(entry.blockNum);
        } catch {
          return undefined;
        }

        let value: bigint;
        try {
          value = BigInt(entry.rawContract.value);
        } catch {
          return undefined;
        }

        const txHash = entry.hash as Hash;
        const logIndex = parseLogIndex(entry, index);
        const rawUniqueId = entry.uniqueId?.trim();
        const uniqueId = rawUniqueId && rawUniqueId.length > 0 ? rawUniqueId : `${entry.hash}:${logIndex}`;

        return {
          blockNumber,
          from: entry.from,
          logIndex,
          timestamp: parseTimestamp(entry),
          to: entry.to,
          txHash,
          uniqueId,
          value,
        } satisfies ParsedAssetTransfer;
      })
      .filter((entry): entry is ParsedAssetTransfer => entry !== undefined);

    const missingTimestampBlockValues = [...new Set(
      parsedTransfers.filter((entry) => entry.timestamp == null).map((entry) => entry.blockNumber.toString())
    )].map((value) => BigInt(value));

    yield* Effect.logDebug(
      `Resolving timestamps for ${missingTimestampBlockValues.length} block(s) missing metadata timestamp...`
    );

    const timestamps = yield* resolveBlockTimestamps(client, missingTimestampBlockValues);
    const timestampByBlock = new Map(timestamps.map((entry) => [entry.blockNumber.toString(), entry.timestamp]));

    const walletLower = params.walletAddress.toLowerCase();

    const mapped = parsedTransfers
      .map((entry) => {
        const blockTimestamp = entry.timestamp ?? timestampByBlock.get(entry.blockNumber.toString());
        if (blockTimestamp === undefined) {
          return undefined;
        }

        const unsignedAmount = Number(formatUnits(entry.value, tokenMeta.decimals));
        const signedAmount = entry.to.toLowerCase() === walletLower ? unsignedAmount : -unsignedAmount;

        return {
          amount: signedAmount,
          amountRaw: entry.value.toString(),
          blockNumber: entry.blockNumber,
          date: new Date(blockTimestamp * 1_000).toISOString().slice(0, 10),
          from: entry.from,
          logIndex: entry.logIndex,
          network: networkKey,
          timestamp: blockTimestamp,
          to: entry.to,
          tokenAddress: params.tokenAddress,
          tokenSymbol: tokenMeta.symbol,
          txHash: entry.txHash,
          uniqueId: `${chainId}-${entry.txHash}-${entry.logIndex}`,
        } satisfies TransferRecord;
      })
      .filter((entry): entry is TransferRecord => entry !== undefined)
      .sort((a, b) => {
        if (a.timestamp === b.timestamp) {
          if (a.blockNumber === b.blockNumber) {
            return a.logIndex - b.logIndex;
          }
          return a.blockNumber < b.blockNumber ? -1 : 1;
        }
        return a.timestamp - b.timestamp;
      });

    return mapped;
  });

export class RpcService extends Effect.Service<RpcService>()("RpcService", {
  succeed: {
    assertAddress,
    getTransferRecords,
  },
  accessors: true,
}) {}
