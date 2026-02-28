import * as PlatformError from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import { Data, Effect, ParseResult, Schema } from "effect";
import path from "node:path";

import type { Address } from "viem";
import { isAddress } from "viem";
import { supportsAlchemyNetwork } from "./constants";

export const CONFIG_FILE_NAME = ".erc20-odoo-sync.config.json";

const AddressSchema = Schema.String.pipe(
  Schema.filter((value): value is Address => isAddress(value), {
    message: () => "Expected a valid EVM address",
  })
);
const NetworkSchema = Schema.String.pipe(
  Schema.filter((network) => supportsAlchemyNetwork(network), {
    message: () => "Expected an Alchemy-supported chain key",
  })
);
const AlchemyApiKeySchema = Schema.String.pipe(
  Schema.filter((value) => value.trim().length > 0, {
    message: () => "Expected a non-empty Alchemy API key",
  })
);

const AppConfigFields = {
  odooApiKey: Schema.String,
  odooUrl: Schema.String,
  companyId: Schema.optional(Schema.Number.pipe(Schema.int())),
  companyName: Schema.optional(Schema.String),
  journalId: Schema.Number.pipe(Schema.int()),
  journalName: Schema.String,
  network: NetworkSchema,
  tokenAddress: AddressSchema,
  tokenSymbol: Schema.optional(Schema.String),
  walletAddress: Schema.optional(AddressSchema),
  alchemyApiKey: AlchemyApiKeySchema,
};

const AppConfigDocumentSchema = Schema.Struct(AppConfigFields);
const NamedAppConfigDocumentSchema = Schema.Struct({
  id: Schema.Number.pipe(Schema.int()),
  ...AppConfigFields,
});
const AppConfigStoreDocumentSchema = Schema.Struct({
  profiles: Schema.Array(NamedAppConfigDocumentSchema),
  defaultProfileId: Schema.optional(Schema.Number.pipe(Schema.int())),
});

const AppConfigStoreJsonSchema = Schema.parseJson(AppConfigStoreDocumentSchema);

export type AppConfig = Schema.Schema.Type<typeof AppConfigDocumentSchema>;
export type NamedAppConfig = Schema.Schema.Type<typeof NamedAppConfigDocumentSchema>;
export type AppConfigStore = Schema.Schema.Type<typeof AppConfigStoreDocumentSchema>;

export class ConfigError extends Data.TaggedError("ConfigError")<{
  message: string;
}> {}

export const resolveConfigPath = (): string => path.resolve(process.cwd(), CONFIG_FILE_NAME);

type ConfigFileError = PlatformError.PlatformError | ConfigError;

const isNotFoundError = (error: ConfigFileError): boolean =>
  error._tag === "SystemError" && error.reason === "NotFound";

const toReadError = (error: ConfigFileError, configPath: string): ConfigError => {
  if (error._tag === "ConfigError") {
    return error;
  }
  if (isNotFoundError(error)) {
    return new ConfigError({
      message: `Config file not found at ${configPath}. Run \`bun run setup\` first.`,
    });
  }
  return new ConfigError({
    message: `Failed to read config at ${configPath}: ${error.message}`,
  });
};

const toWriteError = (error: ConfigFileError, configPath: string): ConfigError => {
  if (error._tag === "ConfigError") {
    return error;
  }
  return new ConfigError({
    message: `Failed to write config at ${configPath}: ${error.message}`,
  });
};

const normalizeStore = (store: AppConfigStore): AppConfigStore => {
  const defaultProfileId = store.defaultProfileId;
  if (defaultProfileId != null && store.profiles.some((profile) => profile.id === defaultProfileId)) {
    return store;
  }

  const nextDefaultProfileId = store.profiles[0]?.id;
  return {
    profiles: store.profiles,
    ...(nextDefaultProfileId != null ? { defaultProfileId: nextDefaultProfileId } : {}),
  };
};

const decodeStore = (raw: string, configPath: string): Effect.Effect<AppConfigStore, ConfigError> =>
  Schema.decode(AppConfigStoreJsonSchema)(raw).pipe(
    Effect.map(normalizeStore),
    Effect.mapError(
      (error) =>
        new ConfigError({
          message: `Invalid config at ${configPath}:\n${ParseResult.TreeFormatter.formatErrorSync(error)}`,
        })
    )
  );

const encodeStore = (store: AppConfigStore, configPath: string): Effect.Effect<string, ConfigError> =>
  Schema.encode(AppConfigStoreDocumentSchema)(normalizeStore(store)).pipe(
    Effect.map((encoded) => `${JSON.stringify(encoded, null, 2)}\n`),
    Effect.mapError(
      (error) =>
        new ConfigError({
          message: `Failed to encode config for ${configPath}:\n${ParseResult.TreeFormatter.formatErrorSync(error)}`,
        })
    )
  );

const loadStoreRaw = (configPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(configPath);
    return yield* decodeStore(raw, configPath);
  });

export const loadConfigStore = (configPath = resolveConfigPath()) =>
  loadStoreRaw(configPath).pipe(Effect.mapError((error) => toReadError(error, configPath)));

export const loadConfigStoreOptional = (configPath = resolveConfigPath()) =>
  loadStoreRaw(configPath).pipe(
    Effect.catchAll((error) => {
      if (isNotFoundError(error)) {
        return Effect.succeed(undefined);
      }
      return Effect.fail(toReadError(error, configPath));
    })
  );

export const saveConfigStore = (store: AppConfigStore, configPath = resolveConfigPath()) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const serialized = yield* encodeStore(store, configPath);
    yield* fs.writeFileString(configPath, serialized);
    return configPath;
  }).pipe(Effect.mapError((error) => toWriteError(error, configPath)));
