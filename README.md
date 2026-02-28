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

## Download Latest Release

Latest release page:

`https://github.com/johanneskares/crypto-odoo-sync/releases/latest`

Direct latest assets:

- macOS universal (arm64 + x64): `https://github.com/johanneskares/crypto-odoo-sync/releases/latest/download/crypto-odoo-sync-macos-universal.tar.gz`
- Linux x64: `https://github.com/johanneskares/crypto-odoo-sync/releases/latest/download/crypto-odoo-sync-linux-x64.tar.gz`
- Windows x64: `https://github.com/johanneskares/crypto-odoo-sync/releases/latest/download/crypto-odoo-sync-windows-x64.zip`

Test with curl (macOS):

```bash
curl -L -o crypto-odoo-sync-macos-universal.tar.gz \
  https://github.com/johanneskares/crypto-odoo-sync/releases/latest/download/crypto-odoo-sync-macos-universal.tar.gz
tar -xzf crypto-odoo-sync-macos-universal.tar.gz
chmod +x crypto-odoo-sync-macos-universal
./crypto-odoo-sync-macos-universal --help
```

If your repo is private, use a GitHub token:

```bash
curl -L \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -o crypto-odoo-sync-macos-universal.tar.gz \
  https://github.com/johanneskares/crypto-odoo-sync/releases/latest/download/crypto-odoo-sync-macos-universal.tar.gz
```

## Setup (`bun run setup`)

The setup command is interactive and lets you:

- add a new config profile
- edit an existing config profile
- remove a config profile

When creating/editing a profile, it asks for:
- Odoo URL
- Odoo API key
- Odoo company (selected first)
- Odoo journal (existing or create new, scoped to selected company)
- Profile name is always set to the selected Odoo journal name
- Network (all `viem/chains` options)
- Alchemy API key (optional; if empty, public RPC is used)
- ERC-20 token address (USDC/EURC suggestions + custom input)
- Wallet address filter (required)

All profiles are saved to:

`.erc20-odoo-sync.config.json`

## Sync (`bun run sync`)

First, choose the config profile to use.

Prompts for:
- `from` date (`YYYY-MM-DD`)
- `to` date (`YYYY-MM-DD`)

Then it:
- reads ERC-20 `Transfer` logs
- converts them to Odoo statement lines
- de-duplicates by `unique_import_id`
- creates new lines in Odoo

## Commands

```bash
bun run setup
bun run sync
bun run sync -- --verbose
bun run sync -- --log-level debug
bun run start -- --help
```

## Tips

- Each profile ingests transfers for exactly one configured wallet address.
- Release binaries are built with Bun baseline targets for broader CPU compatibility.
- Use `bun run setup` anytime to add/remove profiles or update existing ones.
- If you used an older single-config file format, run `bun run setup` once to recreate the config file.
