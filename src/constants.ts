import type { Address, Chain } from "viem";
import * as viemChains from "viem/chains";

const CHAIN_ALIASES = new Map<string, string>([["ethereum", "mainnet"]]);

const isChain = (value: object | null): value is Chain => {
  if (value === null) {
    return false;
  }

  const maybe = value as Partial<Chain>;
  return typeof maybe.id === "number" && typeof maybe.name === "string";
};

const hasDefaultHttpRpc = (chain: Chain): boolean => {
  const urls = chain.rpcUrls?.default?.http;
  return Array.isArray(urls) && urls.length > 0;
};

export interface SelectableChain {
  key: string;
  chain: Chain;
}

const RAW_CHAINS: readonly SelectableChain[] = Object.entries(viemChains)
  .filter(([, value]) => isChain(value))
  .map(([key, chain]) => ({ key, chain }))
  .filter((entry) => hasDefaultHttpRpc(entry.chain))
  .sort((a, b) => {
    const byName = a.chain.name.localeCompare(b.chain.name);
    if (byName !== 0) {
      return byName;
    }

    const byId = a.chain.id - b.chain.id;
    if (byId !== 0) {
      return byId;
    }

    return a.key.localeCompare(b.key);
  });

const CHAINS_BY_KEY = new Map<string, SelectableChain>(RAW_CHAINS.map((entry) => [entry.key, entry]));
const CHAINS_BY_ID = new Map<number, SelectableChain>();
for (const entry of RAW_CHAINS) {
  if (!CHAINS_BY_ID.has(entry.chain.id)) {
    CHAINS_BY_ID.set(entry.chain.id, entry);
  }
}

const normalizeNetworkKey = (network: string): string => CHAIN_ALIASES.get(network) ?? network;

export const resolveChainOption = (network: string): SelectableChain | undefined => {
  const normalized = normalizeNetworkKey(network.trim());
  return CHAINS_BY_KEY.get(normalized);
};

export const resolveChainOptionById = (chainId: number): SelectableChain | undefined => CHAINS_BY_ID.get(chainId);

export interface ChainSelectOption {
  key: string;
  name: string;
  chainId: number;
  title: string;
}

export const CHAIN_OPTIONS: readonly ChainSelectOption[] = RAW_CHAINS.map((entry) => ({
  key: entry.key,
  name: entry.chain.name,
  chainId: entry.chain.id,
  title: `${entry.chain.name} (${entry.key}, id=${entry.chain.id})`,
}));

export const getExplorerTxUrl = (network: string, txHash: string): string | undefined => {
  const chain = resolveChainOption(network)?.chain;
  const explorerBase = chain?.blockExplorers?.default?.url;
  if (!explorerBase) {
    return undefined;
  }

  return `${explorerBase.replace(/\/$/, "")}/tx/${txHash}`;
};

export interface TokenSuggestion {
  symbol: string;
  networkKey: string;
  address: Address;
}

const TOKEN_SUGGESTIONS: readonly TokenSuggestion[] = [
  {
    symbol: "USDC",
    networkKey: "arbitrum",
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  {
    symbol: "USDC",
    networkKey: "base",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  {
    symbol: "EURC",
    networkKey: "base",
    address: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
  },
  {
    symbol: "USDC",
    networkKey: "mainnet",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  {
    symbol: "EURC",
    networkKey: "mainnet",
    address: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c",
  },
];

const tokenDedupKey = (suggestion: TokenSuggestion): string =>
  `${suggestion.symbol}:${normalizeNetworkKey(suggestion.networkKey)}:${suggestion.address.toLowerCase()}`;

export const getTokenSuggestions = (network: string): readonly TokenSuggestion[] => {
  const normalized = normalizeNetworkKey(network);

  const preferred = TOKEN_SUGGESTIONS.filter(
    (suggestion) => normalizeNetworkKey(suggestion.networkKey) === normalized
  );
  const others = TOKEN_SUGGESTIONS.filter(
    (suggestion) => normalizeNetworkKey(suggestion.networkKey) !== normalized
  );

  const ordered = [...preferred, ...others];
  const deduped = new Map<string, TokenSuggestion>();

  for (const suggestion of ordered) {
    deduped.set(tokenDedupKey(suggestion), suggestion);
  }

  return [...deduped.values()];
};

export const getNetworkDisplayName = (network: string): string =>
  resolveChainOption(network)?.chain.name ?? network;

export const supportsAlchemyNetwork = (network: string): boolean => {
  return resolveChainOption(network) != null;
};

export const resolveAlchemyRpcUrl = (network: string, apiKey: string): string | undefined => {
  const chain = resolveChainOption(network)?.chain;
  if (!chain) {
    return undefined;
  }

  const normalizedKey = apiKey.trim();
  if (normalizedKey.length === 0) {
    return undefined;
  }

  return `https://${chain.id}.g.alchemy.com/v2/${normalizedKey}`;
};
