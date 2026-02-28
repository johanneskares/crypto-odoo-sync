import { Data, Effect, Schedule } from "effect";
import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  isAddress,
  parseAbiItem,
  type Address,
  type Hash,
} from "viem";

import { resolveAlchemyRpcUrl, resolveChainOption, type RpcProvider } from "./constants";

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const CHUNK_SIZE = 10_000n;
const LOG_PROGRESS_EVERY_CHUNKS = 10;
const BLOCK_SEARCH_LOG_EVERY_STEPS = 8;
const RPC_REQUEST_TIMEOUT = "30 seconds";
const RPC_RETRY_DELAY = "200 millis";
const RPC_RETRY_TIMES = 2;

type AnyPublicClient = ReturnType<typeof createPublicClient>;
interface Erc20ReadClient {
  readContract: (parameters: {
    abi: typeof erc20Abi;
    address: Address;
    functionName: "decimals" | "symbol";
  }) => Promise<string | number | bigint>;
}

const toErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

const queryTransferLogs = (
  client: AnyPublicClient,
  tokenAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
  args?: { from?: Address; to?: Address }
) =>
  client.getLogs({
    address: tokenAddress,
    event: transferEvent,
    ...(args ? { args } : {}),
    fromBlock,
    toBlock,
    strict: true,
  });
type TransferLog = Awaited<ReturnType<typeof queryTransferLogs>>[number];

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
  rpcProvider: RpcProvider,
  alchemyApiKey?: string
): Effect.Effect<{ client: AnyPublicClient; networkKey: string; rpcUrl: string; rpcMode: RpcProvider }, ChainError> =>
  Effect.sync(() => {
    const chainOption = resolveChainOption(network);
    if (!chainOption) {
      throw new ChainError({
        message: `Unsupported network \\\"${network}\\\". Pick a chain from setup again.`,
      });
    }

    let rpcUrl: string | undefined;
    let rpcMode: RpcProvider = rpcProvider;

    if (rpcProvider === "alchemy") {
      const alchemyUrl = resolveAlchemyRpcUrl(network, alchemyApiKey ?? "");
      if (!alchemyUrl) {
        throw new ChainError({
          message: "Alchemy is selected but no valid Alchemy API key is configured.",
        });
      }
      rpcUrl = alchemyUrl;
    } else {
      rpcUrl = chainOption.chain.rpcUrls.default.http[0];
    }

    if (!rpcUrl) {
      throw new ChainError({
        message: `No RPC URL available for network \"${network}\".`,
      });
    }

    return {
      client: createPublicClient({
        chain: chainOption.chain,
        transport: http(rpcUrl),
      }),
      networkKey: chainOption.key,
      rpcUrl,
      rpcMode,
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
): Effect.Effect<TransferLog[], ChainError> =>
  Effect.gen(function* () {
    const logs: TransferLog[] = [];

    if (fromBlock > toBlock) {
      return logs;
    }

    const totalChunks = Number((toBlock - fromBlock) / CHUNK_SIZE + 1n);
    let chunkIndex = 0;
    let current = fromBlock;
    while (current <= toBlock) {
      const end = current + CHUNK_SIZE > toBlock ? toBlock : current + CHUNK_SIZE;
      chunkIndex += 1;
      if (
        chunkIndex === 1 ||
        chunkIndex === totalChunks ||
        chunkIndex % LOG_PROGRESS_EVERY_CHUNKS === 0
      ) {
        yield* Effect.logDebug(`Fetching ${label}: chunk ${chunkIndex}/${totalChunks} (blocks ${current}-${end})`);
      }

      const chunk = yield* withRpcTimeoutAndRetry(
        Effect.promise(() => queryTransferLogs(client, tokenAddress, current, end, args)).pipe(
          Effect.catchAllDefect((error) =>
            Effect.fail(
              new ChainError({
                message: `Failed to query transfer logs ${current}-${end}: ${toErrorMessage(error)}`,
              })
            )
          )
        ),
        `Timed out querying ${label} for block range ${current}-${end}`
      );

      logs.push(...chunk);
      current = end + 1n;
    }

    return logs;
  });

const fetchWalletTransfers = (
  client: AnyPublicClient,
  tokenAddress: Address,
  wallet: Address,
  fromBlock: bigint,
  toBlock: bigint
): Effect.Effect<TransferLog[], ChainError> =>
  Effect.gen(function* () {
    yield* Effect.logDebug("Scanning incoming transfer logs...");
    const incoming = yield* fetchTransfers(client, tokenAddress, fromBlock, toBlock, { to: wallet }, "incoming");

    yield* Effect.logDebug("Scanning outgoing transfer logs...");
    const outgoing = yield* fetchTransfers(client, tokenAddress, fromBlock, toBlock, { from: wallet }, "outgoing");

    const deduped = new Map<string, TransferLog>();
    for (const entry of [...incoming, ...outgoing]) {
      deduped.set(`${entry.transactionHash}-${entry.logIndex}`, entry);
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
  rpcProvider?: RpcProvider;
  alchemyApiKey?: string;
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

    const { client, networkKey, rpcUrl, rpcMode } = yield* makeClient(
      params.network,
      params.rpcProvider ?? "public",
      params.alchemyApiKey
    );
    yield* Effect.logDebug(`RPC client ready for network=${networkKey}, mode=${rpcMode}, endpoint=${rpcUrl}`);

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

    const estimatedChunksPerDirection = Number((toBlock - fromBlock) / CHUNK_SIZE + 1n);
    yield* Effect.logDebug(
      `Resolved block range ${fromBlock}-${toBlock} (~${estimatedChunksPerDirection} chunks per direction)`
    );

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

    const uniqueBlocks = [...new Set(rawLogs.map((entry) => String(entry.blockNumber)))].map((value) => BigInt(value));
    yield* Effect.logDebug(`Resolving timestamps for ${uniqueBlocks.length} unique block(s)...`);
    const timestamps = yield* resolveBlockTimestamps(client, uniqueBlocks);
    const timestampByBlock = new Map(timestamps.map((entry) => [entry.blockNumber.toString(), entry.timestamp]));

    const walletLower = params.walletAddress.toLowerCase();

    const mapped = rawLogs
      .map((entry) => {
        const blockTimestamp = timestampByBlock.get(entry.blockNumber.toString());
        if (blockTimestamp === undefined || entry.logIndex == null || entry.transactionHash == null) {
          return undefined;
        }

        const from = entry.args.from;
        const to = entry.args.to;
        const value = entry.args.value;

        if (!from || !to || value === undefined) {
          return undefined;
        }

        const unsignedAmount = Number(formatUnits(value, tokenMeta.decimals));
        const signedAmount = to.toLowerCase() === walletLower ? unsignedAmount : -unsignedAmount;

        return {
          amount: signedAmount,
          amountRaw: value.toString(),
          blockNumber: entry.blockNumber,
          date: new Date(blockTimestamp * 1_000).toISOString().slice(0, 10),
          from,
          logIndex: entry.logIndex,
          network: networkKey,
          timestamp: blockTimestamp,
          to,
          tokenAddress: params.tokenAddress,
          tokenSymbol: tokenMeta.symbol,
          txHash: entry.transactionHash,
          uniqueId: `${networkKey}-${entry.transactionHash}-${entry.logIndex}`,
        } satisfies TransferRecord;
      })
      .filter((entry): entry is TransferRecord => entry !== undefined)
      .sort((a, b) => {
        if (a.timestamp === b.timestamp) {
          return a.logIndex - b.logIndex;
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
