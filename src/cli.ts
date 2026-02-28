#!/usr/bin/env node
import { Command, Options, Prompt } from "@effect/cli";
import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer, LogLevel, Logger } from "effect";
import type { Address } from "viem";

import {
  type AppConfig,
  type AppConfigStore,
  type NamedAppConfig,
  loadConfigStore,
  loadConfigStoreOptional,
  saveConfigStore,
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

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const isValidIsoDate = (value: string): boolean => {
  const input = value.trim();
  const match = ISO_DATE_PATTERN.exec(input);
  if (!match) {
    return false;
  }

  const [, yearRaw, monthRaw, dayRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const promptIsoDate = (message: string, defaultValue?: string) =>
  Prompt.run(
    Prompt.text({
      message,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      validate: (value) =>
        isValidIsoDate(value)
          ? Effect.succeed(value)
          : Effect.fail("Invalid date. Use YYYY-MM-DD (example: 2025-02-01)."),
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

const configLabel = (profile: NamedAppConfig) =>
  `${profile.name} | ${getNetworkDisplayName(profile.network)} (${profile.network}) | ${profile.tokenSymbol ?? "ERC-20"} ${profile.tokenAddress}`;

const orderProfiles = (profiles: readonly NamedAppConfig[], defaultProfile?: string): NamedAppConfig[] =>
  [...profiles].sort((a, b) => {
    const aDefault = defaultProfile != null && a.name === defaultProfile;
    const bDefault = defaultProfile != null && b.name === defaultProfile;
    if (aDefault && !bDefault) {
      return -1;
    }
    if (!aDefault && bDefault) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });

const pickProfile = (message: string, profiles: readonly NamedAppConfig[], defaultProfile?: string) =>
  promptSelect(
    message,
    orderProfiles(profiles, defaultProfile).map((profile) => ({
      title: configLabel(profile),
      value: profile,
    }))
  );

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

const normalizeSearchQuery = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const matchesNetworkSearch = (network: (typeof CHAIN_OPTIONS)[number], normalizedQuery: string): boolean => {
  if (normalizedQuery.length === 0) {
    return true;
  }

  const searchable = `${network.name} ${network.key} ${network.chainId}`.toLowerCase();
  return normalizedQuery.split(" ").every((term) => searchable.includes(term));
};

const pickNetwork = (preferredNetwork?: string) =>
  Effect.gen(function* () {
    const ordered = [...CHAIN_OPTIONS].sort((a, b) => {
      const aPreferred = preferredNetwork != null && a.key === preferredNetwork;
      const bPreferred = preferredNetwork != null && b.key === preferredNetwork;
      if (aPreferred && !bPreferred) {
        return -1;
      }
      if (!aPreferred && bPreferred) {
        return 1;
      }
      return a.title.localeCompare(b.title);
    });

    let searchQuery = yield* promptText(
      "Search blockchain network (name, key, or chain id). Leave empty to show all.",
      ""
    ).pipe(Effect.map(normalizeSearchQuery));

    while (true) {
      const matched = ordered.filter((network) => matchesNetworkSearch(network, searchQuery));
      if (matched.length > 0) {
        const message =
          searchQuery.length > 0 ? `Choose blockchain network (filtered: ${searchQuery})` : "Choose blockchain network";
        return yield* promptSelect(
          message,
          matched.map((network) => ({ title: network.title, value: network.key }))
        );
      }

      yield* Console.log(`No blockchain networks match "${searchQuery}".`);
      searchQuery = yield* promptText(
        "Search blockchain network (name, key, or chain id). Leave empty to show all.",
        searchQuery
      ).pipe(Effect.map(normalizeSearchQuery));
    }
  });

const pickTokenAddress = (network: string, existingTokenAddress?: Address, existingTokenSymbol?: string) =>
  Effect.gen(function* () {
    const suggestions = getTokenSuggestions(network);
    const existingLower = existingTokenAddress?.toLowerCase();

    const orderedSuggestions = [...suggestions].sort((a, b) => {
      const aPreferred = existingLower != null && a.address.toLowerCase() === existingLower;
      const bPreferred = existingLower != null && b.address.toLowerCase() === existingLower;
      if (aPreferred && !bPreferred) {
        return -1;
      }
      if (!aPreferred && bPreferred) {
        return 1;
      }
      return 0;
    });

    const knownExistingToken =
      existingLower != null && orderedSuggestions.some((suggestion) => suggestion.address.toLowerCase() === existingLower);

    const configuredChoice =
      existingTokenAddress && !knownExistingToken
        ? [
            {
              title: `Current configured token - ${existingTokenAddress}`,
              value: { tokenAddress: existingTokenAddress, tokenSymbol: existingTokenSymbol },
            },
          ]
        : [];

    const tokenChoice = yield* promptSelect("Choose ERC-20 token contract", [
      ...configuredChoice,
      ...orderedSuggestions.map((suggestion) => ({
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

const configureProfile = (existingProfile: NamedAppConfig | undefined, allProfiles: readonly NamedAppConfig[]) =>
  Effect.gen(function* () {
    const odooUrl = yield* promptRequired("Odoo URL", existingProfile?.odooUrl ?? process.env.ODOO_URL ?? "");
    const odooApiKey = yield* promptRequired(
      "Odoo API Key",
      existingProfile?.odooApiKey ?? process.env.ODOO_API_KEY ?? ""
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
      const aPreferred = existingProfile?.companyId != null && a.id === existingProfile.companyId;
      const bPreferred = existingProfile?.companyId != null && b.id === existingProfile.companyId;
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

    let journalId = existingProfile?.journalId ?? 0;
    let journalName = existingProfile?.journalName ?? "";

    if (journalMode === "existing") {
      if (journals.length === 0) {
        return yield* Effect.fail(
          new Error(`No journal exists in company "${selectedCompany.name}". Choose "Create a new journal".`)
        );
      }

      const sortedJournals = [...journals].sort((a, b) => {
        const aPreferred = existingProfile?.journalId != null && a.id === existingProfile.journalId;
        const bPreferred = existingProfile?.journalId != null && b.id === existingProfile.journalId;
        if (aPreferred && !bPreferred) {
          return -1;
        }
        if (!aPreferred && bPreferred) {
          return 1;
        }
        return a.name.localeCompare(b.name);
      });

      const selectedJournal = yield* promptSelect(
        "Select existing journal",
        sortedJournals.map((journal) => ({
          title: journalLabel(journal),
          value: journal,
        }))
      );

      journalId = selectedJournal.id;
      journalName = selectedJournal.name;
    } else {
      const name = yield* promptRequired("New journal name", existingProfile?.journalName ?? "Crypto Transfers");
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

    const profileName = journalName.trim();
    if (profileName.length === 0) {
      return yield* Effect.fail(new Error("Selected Odoo journal has an empty name. Set a journal name in Odoo first."));
    }

    const duplicateProfile = allProfiles.find(
      (profile) => profile.name === profileName && profile.name !== existingProfile?.name
    );
    if (duplicateProfile) {
      return yield* Effect.fail(
        new Error(
          `A config profile named "${profileName}" already exists. Rename the Odoo journal or remove the existing profile first.`
        )
      );
    }

    const network = yield* pickNetwork(existingProfile?.network);
    const alchemyApiKey = yield* promptText(
      "Alchemy API Key (optional, leave empty to use public RPC)",
      existingProfile?.alchemyApiKey ?? process.env.ALCHEMY_API_KEY ?? ""
    ).pipe(
      Effect.map((value) => value.trim()),
      Effect.map((value) => (value.length > 0 ? value : undefined))
    );
    const token = yield* pickTokenAddress(network, existingProfile?.tokenAddress, existingProfile?.tokenSymbol);

    const walletAddress = yield* promptRequired(
      "Wallet address (required, 0x...)",
      existingProfile?.walletAddress ?? ""
    ).pipe(Effect.flatMap((value) => RpcService.assertAddress(value, "wallet address")));

    return {
      name: profileName,
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
      alchemyApiKey,
    } satisfies NamedAppConfig;
  });

const setupProgram = Effect.gen(function* () {
  const store: AppConfigStore = (yield* loadConfigStoreOptional()) ?? { profiles: [] };

  const action =
    store.profiles.length === 0
      ? ("add" as const)
      : yield* promptSelect("Setup action", [
          {
            title: "Add a new config profile",
            value: "add" as const,
          },
          {
            title: "Edit an existing config profile",
            value: "edit" as const,
          },
          {
            title: "Remove a config profile",
            value: "remove" as const,
          },
        ]);

  if (action === "remove") {
    const toRemove = yield* pickProfile("Select config profile to remove", store.profiles, store.defaultProfile);
    const profiles = store.profiles.filter((profile) => profile.name !== toRemove.name);
    const nextDefaultProfile =
      store.defaultProfile === toRemove.name ? profiles[0]?.name : store.defaultProfile ?? profiles[0]?.name;

    const nextStore: AppConfigStore = {
      profiles,
      ...(nextDefaultProfile ? { defaultProfile: nextDefaultProfile } : {}),
    };
    const configPath = yield* saveConfigStore(nextStore);

    yield* Console.log(`\nRemoved config profile "${toRemove.name}".`);
    yield* Console.log(`File: ${configPath}`);
    if (profiles.length === 0) {
      yield* Console.log("No config profiles left. Run `bun run setup` to add one.");
    } else {
      yield* Console.log(`Remaining profiles: ${profiles.length}`);
      yield* Console.log(`Default profile: ${nextStore.defaultProfile}`);
    }
    return;
  }

  const profileToEdit =
    action === "edit"
      ? yield* pickProfile("Select config profile to edit", store.profiles, store.defaultProfile)
      : undefined;

  const configuredProfile = yield* configureProfile(profileToEdit, store.profiles);

  const profiles =
    action === "edit" && profileToEdit
      ? store.profiles.map((profile) => (profile.name === profileToEdit.name ? configuredProfile : profile))
      : [...store.profiles, configuredProfile];

  const nextStore: AppConfigStore = {
    profiles,
    defaultProfile: configuredProfile.name,
  };

  const configPath = yield* saveConfigStore(nextStore);

  yield* Console.log("\nConfiguration saved.");
  yield* Console.log(`File: ${configPath}`);
  yield* Console.log(`Profile: ${configuredProfile.name}`);
  yield* Console.log(`Company: ${configuredProfile.companyName} (id=${configuredProfile.companyId})`);
  yield* Console.log(`Journal: ${configuredProfile.journalName} (id=${configuredProfile.journalId})`);
  yield* Console.log(
    `Network: ${getNetworkDisplayName(configuredProfile.network)} (${configuredProfile.network})`
  );
  const rpcMode = configuredProfile.alchemyApiKey ? "alchemy" : "public";
  yield* Console.log(`RPC mode: ${rpcMode}`);
  if (configuredProfile.alchemyApiKey) {
    yield* Console.log("Alchemy API Key: configured");
  }
  yield* Console.log(`Token: ${configuredProfile.tokenAddress}`);
  yield* Console.log(`Wallet filter: ${configuredProfile.walletAddress}`);
  yield* Console.log(`Total profiles: ${profiles.length}`);
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

const verboseOption = Options.boolean("verbose").pipe(
  Options.withAlias("v"),
  Options.withDescription("Enable detailed sync logs (block ranges, chunk progress, and timing)"),
  Options.withDefault(false)
);

const syncProgram = (options: { verbose: boolean }) => {
  const program = Effect.gen(function* () {
    const store = yield* loadConfigStore();
    if (store.profiles.length === 0) {
      return yield* Effect.fail(
        new Error("No config profiles found. Run `bun run setup` and add at least one config profile.")
      );
    }

    const config = yield* pickProfile("Choose config profile for sync", store.profiles, store.defaultProfile);
    const walletAddress = config.walletAddress;
    if (!walletAddress) {
      return yield* Effect.fail(
        new Error(`Wallet address is required in profile "${config.name}". Run \`bun run setup\`.`)
      );
    }

    const fromDate = yield* promptIsoDate("From date (YYYY-MM-DD)", defaultFromDate());
    const toDate = yield* promptIsoDate("To date (YYYY-MM-DD)", todayIso());
    const alchemyApiKey = (config.alchemyApiKey ?? process.env.ALCHEMY_API_KEY)?.trim() || undefined;
    const rpcMode = alchemyApiKey ? "alchemy" : "public";

    const startedAt = Date.now();
    const elapsed = () => `${((Date.now() - startedAt) / 1_000).toFixed(1)}s`;

    yield* Effect.logInfo("Reading ERC-20 transfer logs...");
    yield* Effect.logDebug(
      `Sync config: profile=${config.name}, network=${config.network}, token=${config.tokenAddress}, wallet=${walletAddress}, range=${fromDate}..${toDate}, rpcMode=${rpcMode}`
    );

    const transfers = yield* RpcService.getTransferRecords({
      alchemyApiKey,
      fromDate,
      network: config.network,
      toDate,
      tokenAddress: config.tokenAddress,
      walletAddress,
    });
    yield* Effect.logDebug(`Transfer fetch finished after ${elapsed()}`);

    if (transfers.length === 0) {
      yield* Effect.logInfo("No transfers found in this date range.");
      return;
    }

    yield* Effect.logInfo(`Found ${transfers.length} transfer(s). Preparing Odoo statement lines...`);

    const client = {
      apiKey: config.odooApiKey,
      baseUrl: config.odooUrl,
    } satisfies OdooClientConfig;

    const lines = transfers.map((transfer) => toStatementLine(config, transfer));
    const importIds = lines.map((line) => line.unique_import_id);

    yield* Effect.logDebug(`Checking ${importIds.length} import id(s) for deduplication in Odoo...`);
    const existingImportIds = yield* OdooService.fetchExistingImportIds(client, importIds, {
      chunkSize: 100,
      companyId: config.companyId,
      journalId: config.journalId,
    });
    const newLines = lines.filter((line) => !existingImportIds.has(line.unique_import_id));
    yield* Effect.logDebug(`Dedup result: existing=${existingImportIds.size}, new=${newLines.length}`);

    if (newLines.length === 0) {
      yield* Effect.logInfo("All transfers already exist in Odoo (deduplicated by unique_import_id).");
      return;
    }

    let created = 0;
    const batches = chunk(newLines, 200);
    yield* Effect.logDebug(`Writing ${newLines.length} statement line(s) in ${batches.length} batch(es)...`);

    for (const batch of batches) {
      yield* OdooService.createStatementLinesBatch(client, batch);
      created += batch.length;
      yield* Effect.logInfo(`Created ${created}/${newLines.length} statement lines...`);
    }

    yield* Effect.logInfo("Sync completed.");
    yield* Effect.logInfo(`Profile: ${config.name}`);
    yield* Effect.logInfo(`Transfers found: ${transfers.length}`);
    yield* Effect.logInfo(`Already existing in Odoo: ${existingImportIds.size}`);
    yield* Effect.logInfo(`Newly created: ${created}`);
    yield* Effect.logDebug(`Total elapsed: ${elapsed()}`);
  });

  return options.verbose ? program.pipe(Logger.withMinimumLogLevel(LogLevel.Debug)) : program;
};

const setupCommand = Command.make("setup", {}, () => setupProgram).pipe(
  Command.withDescription("Manage config profiles (add, edit, remove) for Odoo + ERC-20 sync")
);

const syncCommand = Command.make("sync", { verbose: verboseOption }, (options) => syncProgram(options)).pipe(
  Command.withDescription("Import ERC-20 transfer transaction data into Odoo")
);

const rootCommand = Command.make("crypto-odoo-sync", {}, () =>
  Console.log("Use a subcommand: setup or sync")
).pipe(
  Command.withDescription("Transfer ERC-20 transaction data into an Odoo journal"),
  Command.withSubcommands([setupCommand, syncCommand])
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
