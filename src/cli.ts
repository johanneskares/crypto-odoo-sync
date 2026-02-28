#!/usr/bin/env node
import { Command, Prompt } from "@effect/cli";
import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import type { Address } from "viem";

import {
  type AppConfig,
  loadConfig,
  loadConfigOptional,
  saveConfig,
} from "./config";
import {
  CHAIN_OPTIONS,
  getExplorerTxUrl,
  getNetworkDisplayName,
  getTokenSuggestions,
} from "./constants";
import { RpcService, type TransferRecord } from "./erc20";
import {
  OdooService,
  type OdooClientConfig,
  type OdooCompanyRecord,
  type OdooJournalRecord,
} from "./odoo-client";

const todayIso = () => new Date().toISOString().slice(0, 10);

const defaultFromDate = () => {
  const current = new Date();
  current.setUTCDate(current.getUTCDate() - 7);
  return current.toISOString().slice(0, 10);
};

const promptText = (message: string, defaultValue?: string) =>
  Prompt.run(
    Prompt.text({
      message,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    })
  );

const promptRequired = (message: string, defaultValue?: string) =>
  Prompt.run(
    Prompt.text({
      message,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      validate: (value) =>
        value.trim().length > 0 ? Effect.succeed(value) : Effect.fail("Value is required."),
    })
  ).pipe(Effect.map((value) => value.trim()));

const promptSelect = <A>(
  message: string,
  choices: ReadonlyArray<{ title: string; value: A; description?: string }>
) =>
  Prompt.run(
    Prompt.select({
      message,
      choices,
    })
  );

const journalLabel = (journal: OdooJournalRecord) => {
  const currency =
    journal.currency_id === false
      ? "no currency"
      : Array.isArray(journal.currency_id)
        ? journal.currency_id[1]
        : `currency ${journal.currency_id}`;

  return `${journal.name} (id=${journal.id}, type=${journal.type}, ${currency})`;
};

const companyLabel = (company: OdooCompanyRecord) => `${company.name} (id=${company.id})`;

const toShortCode = (name: string): string => {
  const alpha = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 5);

  if (alpha.length >= 3) {
    return alpha;
  }

  return `${alpha}JNL`.slice(0, 5);
};

const pickNetwork = () =>
  promptSelect("Choose blockchain network", CHAIN_OPTIONS.map((network) => ({ title: network.title, value: network.key })));

const pickTokenAddress = (network: string) =>
  Effect.gen(function* () {
    const suggestions = getTokenSuggestions(network);

    const tokenChoice = yield* promptSelect("Choose ERC-20 token contract", [
      ...suggestions.map((suggestion) => ({
        title: `${suggestion.symbol} (${getNetworkDisplayName(suggestion.networkKey)} / ${suggestion.networkKey}) - ${suggestion.address}`,
        value: { tokenAddress: suggestion.address, tokenSymbol: suggestion.symbol as string | undefined },
      })),
      {
        title: "Custom contract address",
        value: { tokenAddress: undefined as Address | undefined, tokenSymbol: undefined as string | undefined },
      },
    ]);

    if (tokenChoice.tokenAddress) {
      const validatedTokenAddress = yield* RpcService.assertAddress(tokenChoice.tokenAddress, "ERC-20 address");
      return {
        tokenAddress: validatedTokenAddress,
        tokenSymbol: tokenChoice.tokenSymbol,
      };
    }

    const inputAddress = yield* promptRequired("ERC-20 contract address (0x...)");
    const tokenAddress = yield* RpcService.assertAddress(inputAddress, "ERC-20 address");

    return {
      tokenAddress,
      tokenSymbol: undefined,
    };
  });

const setupProgram = Effect.gen(function* () {
  const existing = yield* loadConfigOptional();

  const odooUrl = yield* promptRequired("Odoo URL", existing?.odooUrl ?? process.env.ODOO_URL ?? "");
  const odooApiKey = yield* promptRequired(
    "Odoo API Key",
    existing?.odooApiKey ?? process.env.ODOO_API_KEY ?? ""
  );

  const client = {
    apiKey: odooApiKey,
    baseUrl: odooUrl,
  } satisfies OdooClientConfig;

  const companies = yield* OdooService.listCompanies(client);
  if (companies.length === 0) {
    return yield* Effect.fail(new Error("No company exists in Odoo for this API key."));
  }

  const sortedCompanies = [...companies].sort((a, b) => {
    const aPreferred = existing?.companyId != null && a.id === existing.companyId;
    const bPreferred = existing?.companyId != null && b.id === existing.companyId;
    if (aPreferred && !bPreferred) {
      return -1;
    }
    if (!aPreferred && bPreferred) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });

  const selectedCompany = yield* promptSelect(
    "Odoo company",
    sortedCompanies.map((company) => ({
      title: companyLabel(company),
      value: company,
    }))
  );

  const journals = yield* OdooService.listJournals(client, selectedCompany.id);

  const journalMode = yield* promptSelect("Odoo journal", [
    {
      title: "Use an existing journal",
      value: "existing" as const,
    },
    {
      title: "Create a new journal",
      value: "create" as const,
    },
  ]);

  let journalId = existing?.journalId ?? 0;
  let journalName = existing?.journalName ?? "";

  if (journalMode === "existing") {
    if (journals.length === 0) {
      return yield* Effect.fail(
        new Error(`No journal exists in company "${selectedCompany.name}". Choose "Create a new journal".`)
      );
    }

    const selectedJournal = yield* promptSelect(
      "Select existing journal",
      journals.map((journal) => ({
        title: journalLabel(journal),
        value: journal,
      }))
    );

    journalId = selectedJournal.id;
    journalName = selectedJournal.name;
  } else {
    const name = yield* promptRequired("New journal name", existing?.journalName ?? "Crypto Transfers");
    const code = yield* promptRequired("New journal short code", toShortCode(name));
    const currencyCode = yield* promptText("Journal currency code (optional, e.g. USD/EUR)", "");

    const createdJournal = yield* OdooService.createJournal(client, {
      code,
      companyId: selectedCompany.id,
      currencyCode: currencyCode.trim().length > 0 ? currencyCode : undefined,
      name,
    });

    journalId = createdJournal.id;
    journalName = createdJournal.name;

    yield* Console.log(`Created journal ${createdJournal.name} (id=${createdJournal.id}).`);
  }

  const network = yield* pickNetwork();
  const token = yield* pickTokenAddress(network);

  const walletAddress = yield* promptRequired("Wallet address (required, 0x...)", existing?.walletAddress ?? "").pipe(
    Effect.flatMap((value) => RpcService.assertAddress(value, "wallet address"))
  );

  const config: AppConfig = {
    companyId: selectedCompany.id,
    companyName: selectedCompany.name,
    journalId,
    journalName,
    network,
    odooApiKey,
    odooUrl,
    tokenAddress: token.tokenAddress,
    tokenSymbol: token.tokenSymbol,
    walletAddress,
  };

  const configPath = yield* saveConfig(config);

  yield* Console.log("\nConfiguration saved.");
  yield* Console.log(`File: ${configPath}`);
  yield* Console.log(`Company: ${selectedCompany.name} (id=${selectedCompany.id})`);
  yield* Console.log(`Journal: ${journalName} (id=${journalId})`);
  yield* Console.log(`Network: ${getNetworkDisplayName(network)} (${network})`);
  yield* Console.log(`Token: ${token.tokenAddress}`);
  yield* Console.log(`Wallet filter: ${walletAddress}`);
});

const toStatementLine = (config: AppConfig, transfer: TransferRecord) => {
  const explorerUrl = getExplorerTxUrl(config.network, transfer.txHash);

  return {
    amount: transfer.amount,
    ...(config.companyId != null ? { company_id: config.companyId } : {}),
    date: transfer.date,
    journal_id: config.journalId,
    narration: `${transfer.from} -> ${transfer.to}${explorerUrl ? ` | ${explorerUrl}` : ""}`,
    payment_ref: `${transfer.tokenSymbol} ${transfer.txHash.slice(0, 12)}`,
    unique_import_id: `ERC20-${transfer.uniqueId}`,
  };
};

const chunk = <T>(items: readonly T[], chunkSize: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
};

const syncProgram = Effect.gen(function* () {
  const config = yield* loadConfig();
  const walletAddress = config.walletAddress;
  if (!walletAddress) {
    return yield* Effect.fail(
      new Error("Wallet address is required. Run `bun run setup` to configure a wallet filter.")
    );
  }

  const fromDate = yield* promptRequired("From date (YYYY-MM-DD)", defaultFromDate());
  const toDate = yield* promptRequired("To date (YYYY-MM-DD)", todayIso());

  yield* Console.log("\nReading ERC-20 transfer logs...");

  const transfers = yield* RpcService.getTransferRecords({
    fromDate,
    network: config.network,
    toDate,
    tokenAddress: config.tokenAddress,
    walletAddress,
  });

  if (transfers.length === 0) {
    yield* Console.log("No transfers found in this date range.");
    return;
  }

  yield* Console.log(`Found ${transfers.length} transfer(s). Preparing Odoo statement lines...`);

  const client = {
    apiKey: config.odooApiKey,
    baseUrl: config.odooUrl,
  } satisfies OdooClientConfig;

  const lines = transfers.map((transfer) => toStatementLine(config, transfer));
  const importIds = lines.map((line) => line.unique_import_id);

  const existingImportIds = yield* OdooService.fetchExistingImportIds(client, importIds, {
    chunkSize: 100,
    companyId: config.companyId,
    journalId: config.journalId,
  });
  const newLines = lines.filter((line) => !existingImportIds.has(line.unique_import_id));

  if (newLines.length === 0) {
    yield* Console.log("All transfers already exist in Odoo (deduplicated by unique_import_id).");
    return;
  }

  let created = 0;
  const batches = chunk(newLines, 200);

  for (const batch of batches) {
    yield* OdooService.createStatementLinesBatch(client, batch);
    created += batch.length;
    yield* Console.log(`Created ${created}/${newLines.length} statement lines...`);
  }

  yield* Console.log("\nSync completed.");
  yield* Console.log(`Transfers found: ${transfers.length}`);
  yield* Console.log(`Already existing in Odoo: ${existingImportIds.size}`);
  yield* Console.log(`Newly created: ${created}`);
});

const setupCommand = Command.make("setup", {}, () => setupProgram).pipe(
  Command.withDescription("Configure Odoo, journal, network, and ERC-20 token settings")
);

const syncCommand = Command.make("sync", {}, () => syncProgram).pipe(
  Command.withDescription("Import ERC-20 transfer transaction data into Odoo")
);

const transferCommand = Command.make("transfer", {}, () => syncProgram).pipe(
  Command.withDescription("Alias of sync")
);

const rootCommand = Command.make("crypto-odoo-sync", {}, () =>
  Console.log("Use a subcommand: setup, sync, or transfer")
).pipe(
  Command.withDescription("Transfer ERC-20 transaction data into an Odoo journal"),
  Command.withSubcommands([setupCommand, syncCommand, transferCommand])
);

const cli = Command.run(rootCommand, {
  name: "ERC-20 -> Odoo Journal CLI",
  version: "v0.2.0",
});

const serviceLayer = Layer.mergeAll(OdooService.Default, RpcService.Default);

cli(process.argv).pipe(
  Effect.provide(serviceLayer),
  Effect.provide(NodeHttpClient.layer),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
);
