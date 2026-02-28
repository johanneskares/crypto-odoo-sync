# crypto-odoo-sync

CLI to sync ERC-20 transfer transactions into Odoo journal statement lines (`account.bank.statement.line`).

## What You Need

- Bun installed
- Odoo URL (for example `https://your-company.odoo.com`)
- Odoo API key with access to:
  - `res.company`
  - `account.journal`
  - `account.bank.statement.line`
- ERC-20 contract address (or pick one of the built-in suggestions)

## Quick Start

```bash
bun install
bun run setup
bun run sync
```

## Setup (`bun run setup`)

The setup command is interactive and asks for:

- Odoo URL
- Odoo API key
- Odoo company (selected first)
- Odoo journal (existing or create new, scoped to selected company)
- Network (all `viem/chains` options)
- ERC-20 token address (USDC/EURC suggestions + custom input)
- Optional wallet filter

It saves your configuration to:

`.erc20-odoo-sync.config.json`

## Sync (`bun run sync`)

Prompts for:
- `from` date (`YYYY-MM-DD`)
- `to` date (`YYYY-MM-DD`)

Then it:
- reads ERC-20 `Transfer` logs
- converts them to Odoo statement lines
- de-duplicates by `unique_import_id`
- creates new lines in Odoo

Alias:

`bun run transfer`

## Commands

```bash
bun run setup
bun run sync
bun run transfer
bun run start -- --help
```

## Tips

- Use a wallet filter unless you intentionally want full-token history.
- If setup fails, run `bun run setup` again to overwrite config.
