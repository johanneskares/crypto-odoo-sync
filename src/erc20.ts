import { Data, Effect } from "effect";
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

import { resolveChainOption } from "./constants";

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const CHUNK_SIZE = 2_000n;
type AnyPublicClient = ReturnType<typeof createPublicClient>;
interface Erc20ReadClient {
  readContract: (parameters: {
    abi: typeof erc20Abi;
    address: Address;
    functionName: "decimals" | "symbol";
  }) => Promise<string | number | bigint>;
}
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

const makeClient = (network: string): Effect.Effect<{ client: AnyPublicClient; networkKey: string }, ChainError> =>
  Effect.sync(() => {
    const chainOption = resolveChainOption(network);
    if (!chainOption) {
      throw new ChainError({
        message: `Unsupported network \\\"${network}\\\". Pick a chain from setup again.`,
      });
    }

    return {
      client: createPublicClient({
        chain: chainOption.chain,
        transport: http(),
      }),
      networkKey: chainOption.key,
    };
  });

const findBlockAtOrAfter = (
  client: AnyPublicClient,
  targetTimestamp: number,
  latestBlock: bigint
): Effect.Effect<bigint, ChainError> =>
  Effect.promise(async () => {
    let left = 0n;
    let right = latestBlock;

    while (left < right) {
      const middle = (left + right) / 2n;
      const block = await client.getBlock({ blockNumber: middle });
      const blockTimestamp = Number(block.timestamp);

      if (blockTimestamp < targetTimestamp) {
        left = middle + 1n;
      } else {
        right = middle;
      }
    }

    return left;
  }).pipe(
    Effect.catchAllDefect((error) =>
      Effect.fail(
        new ChainError({
          message: `Failed to resolve block for timestamp ${targetTimestamp}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        })
      )
    )
  );

const fetchTokenMeta = (client: AnyPublicClient, tokenAddress: Address) => {
  const readClient = client as Erc20ReadClient;

  return Effect.all({
    decimals: Effect.promise(() =>
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
            message: `Could not read token decimals from ${tokenAddress}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        )
      )
    ),
    symbol: Effect.promise(() =>
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
            message: `Could not read token symbol from ${tokenAddress}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        )
      )
    ),
  });
};

const fetchTransfers = (
  client: AnyPublicClient,
  tokenAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
  args?: { from?: Address; to?: Address }
): Effect.Effect<TransferLog[], ChainError> =>
  Effect.gen(function* () {
    const logs: TransferLog[] = [];

    if (fromBlock > toBlock) {
      return logs;
    }

    let current = fromBlock;
    while (current <= toBlock) {
      const end = current + CHUNK_SIZE > toBlock ? toBlock : current + CHUNK_SIZE;
      const chunk = yield* Effect.promise(() => queryTransferLogs(client, tokenAddress, current, end, args)).pipe(
        Effect.catchAllDefect((error) =>
          Effect.fail(
            new ChainError({
              message: `Failed to query transfer logs ${current}-${end}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            })
          )
        )
      );

      logs.push(...chunk);
      current = end + 1n;
    }

    return logs;
  });

const fetchAllTransfers = (
  client: AnyPublicClient,
  tokenAddress: Address,
  fromBlock: bigint,
  toBlock: bigint
): Effect.Effect<TransferLog[], ChainError> => fetchTransfers(client, tokenAddress, fromBlock, toBlock);

const fetchWalletTransfers = (
  client: AnyPublicClient,
  tokenAddress: Address,
  wallet: Address,
  fromBlock: bigint,
  toBlock: bigint
): Effect.Effect<TransferLog[], ChainError> =>
  Effect.gen(function* () {
    const [incoming, outgoing] = yield* Effect.all([
      fetchTransfers(client, tokenAddress, fromBlock, toBlock, { to: wallet }),
      fetchTransfers(client, tokenAddress, fromBlock, toBlock, { from: wallet }),
    ]);

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
      Effect.promise(async () => {
          const block = await client.getBlock({ blockNumber });
          return {
            blockNumber,
            timestamp: Number(block.timestamp),
          };
        }).pipe(
          Effect.catchAllDefect((error) =>
            Effect.fail(
              new ChainError({
                message: `Failed to load block ${blockNumber}: ${error instanceof Error ? error.message : String(error)}`,
              })
            )
          )
        ),
    { concurrency: 8 }
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
  walletAddress?: Address;
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

    const { client, networkKey } = yield* makeClient(params.network);

    const latestBlock = yield* Effect.promise(async () => {
        const latest = await client.getBlock({ blockTag: "latest" });
        return {
          number: latest.number,
          timestamp: Number(latest.timestamp),
        };
      }).pipe(
        Effect.catchAllDefect((error) =>
          Effect.fail(
            new ChainError({
              message: `Failed to load latest block: ${error instanceof Error ? error.message : String(error)}`,
            })
          )
        )
      );

    const fromBlock = yield* findBlockAtOrAfter(client, fromTimestamp, latestBlock.number);

    const toBlock =
      toTimestamp >= latestBlock.timestamp
        ? latestBlock.number
        : (yield* findBlockAtOrAfter(client, toTimestamp + 1, latestBlock.number)) - 1n;

    if (fromBlock > toBlock) {
      return [];
    }

    const tokenMeta = yield* fetchTokenMeta(client, params.tokenAddress);

    const rawLogs = params.walletAddress
      ? yield* fetchWalletTransfers(client, params.tokenAddress, params.walletAddress, fromBlock, toBlock)
      : yield* fetchAllTransfers(client, params.tokenAddress, fromBlock, toBlock);

    if (rawLogs.length === 0) {
      return [];
    }

    const uniqueBlocks = [...new Set(rawLogs.map((entry) => String(entry.blockNumber)))].map((value) => BigInt(value));
    const timestamps = yield* resolveBlockTimestamps(client, uniqueBlocks);
    const timestampByBlock = new Map(timestamps.map((entry) => [entry.blockNumber.toString(), entry.timestamp]));

    const walletLower = params.walletAddress?.toLowerCase();

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
        const signedAmount =
          walletLower == null
            ? unsignedAmount
            : to.toLowerCase() === walletLower
              ? unsignedAmount
              : -unsignedAmount;

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
