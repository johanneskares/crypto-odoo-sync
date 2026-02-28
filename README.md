# crypto-odoo-sync

CLI tool to import ERC-20 transfer transaction data into an Odoo journal (`account.bank.statement.line`) using Odoo JSON-2 APIs.

## Features

- Native `@effect/cli` command structure with interactive `Prompt` flows
- Company-aware setup: select Odoo company first, then scope journal selection/creation to that company
- Odoo journal selection: pick existing or create new
- Network support: every chain exported by `viem/chains` (using each chain's built-in default RPC URL)
- ERC-20 suggestions for USDC and EURC + custom token address
- Optional wallet filter to scope transfer logs
- `sync` command prompts date range and imports transaction-only statement lines
- De-duplication via `unique_import_id`

## Install

```bash
bun install
```

## Configure

```bash
bun run setup
```

This writes config to:

```text
.erc20-odoo-sync.config.json
```

## Run sync

```bash
bun run sync
```

or

```bash
bun run transfer
```

You will be prompted for:

- `from` date (`YYYY-MM-DD`)
- `to` date (`YYYY-MM-DD`)

The command fetches ERC-20 `Transfer` logs and creates `account.bank.statement.line` entries in Odoo.

## Help

```bash
bun run start -- --help
```

## Notes

- Odoo URL is required (for example `https://your-company.odoo.com`).
- Odoo API key must have permissions to read/create journals and statement lines.
- Importing without a wallet filter on high-volume tokens can return very large datasets.
