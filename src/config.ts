import * as PlatformError from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import { Data, Effect, ParseResult, Schema } from "effect";
import path from "node:path";

import type { Address } from "viem";
import { isAddress } from "viem";
import { resolveChainOption } from "./constants";

export const CONFIG_FILE_NAME = ".erc20-odoo-sync.config.json";
const AddressSchema = Schema.String.pipe(
  Schema.filter((value): value is Address => isAddress(value), {
    message: () => "Expected a valid EVM address",
  })
);
const NetworkSchema = Schema.String.pipe(
  Schema.filter((network) => resolveChainOption(network) != null, {
    message: () => "Expected a valid viem chain key",
  })
);
const AppConfigDocumentSchema = Schema.Struct({
  odooApiKey: Schema.String,
  odooUrl: Schema.String,
  companyId: Schema.optional(Schema.Number.pipe(Schema.int())),
  companyName: Schema.optional(Schema.String),
  journalId: Schema.Number.pipe(Schema.int()),
  journalName: Schema.String,
  network: NetworkSchema,
  tokenAddress: AddressSchema,
  tokenSymbol: Schema.optional(Schema.String),
  tokenDecimals: Schema.optional(Schema.Number.pipe(Schema.int())),
  walletAddress: Schema.optional(AddressSchema),
});
const AppConfigJsonSchema = Schema.parseJson(AppConfigDocumentSchema);
export type AppConfig = Schema.Schema.Type<typeof AppConfigDocumentSchema>;

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

const decodeConfig = (raw: string, configPath: string): Effect.Effect<AppConfig, ConfigError> =>
  Schema.decode(AppConfigJsonSchema)(raw).pipe(
    Effect.mapError(
      (error) =>
        new ConfigError({
          message: `Invalid config at ${configPath}:\n${ParseResult.TreeFormatter.formatErrorSync(error)}`,
        })
    )
  );

const encodeConfig = (config: AppConfig, configPath: string): Effect.Effect<string, ConfigError> =>
  Schema.encode(AppConfigJsonSchema)(config).pipe(
    Effect.mapError(
      (error) =>
        new ConfigError({
          message: `Failed to encode config for ${configPath}:\n${ParseResult.TreeFormatter.formatErrorSync(error)}`,
        })
    )
  );

export const loadConfig = (configPath = resolveConfigPath()) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(configPath);
    return yield* decodeConfig(raw, configPath);
  }).pipe(Effect.mapError((error) => toReadError(error, configPath)));

export const loadConfigOptional = (configPath = resolveConfigPath()) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(configPath);
    return yield* decodeConfig(raw, configPath);
  }).pipe(
    Effect.catchAll((error) => {
      if (isNotFoundError(error)) {
        return Effect.succeed(undefined);
      }
      return Effect.fail(toReadError(error, configPath));
    })
  );

export const saveConfig = (config: AppConfig, configPath = resolveConfigPath()) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const serialized = yield* encodeConfig(config, configPath);
    yield* fs.writeFileString(configPath, serialized);
    return configPath;
  }).pipe(Effect.mapError((error) => toWriteError(error, configPath)));
