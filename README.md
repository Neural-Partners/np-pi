# np-pi

Neural Partners' public home for Pi packages, extensions, skills, prompts, themes, and related tooling.

## What lives here

- `packages/*` — public npm packages that can be installed by Pi.
- `local/` — local experiments and personal packages; contents are gitignored except the README.
- `private/` — Neural Partners internal or customer-specific packages; contents are gitignored except the README.
- `docs/` — repo conventions, publishing notes, and implementation specs/plans.

## Current public packages

| Package                 | Purpose                                              | Install                                |
| ----------------------- | ---------------------------------------------------- | -------------------------------------- |
| `@neuralpartners/pi-yo` | Trusted-local inter-session messaging for Pi agents. | `pi install npm:@neuralpartners/pi-yo` |

See each package's README for package-specific usage, license, and verification details.

## Development

Use Node.js 22+ and npm workspaces.

```bash
npm install
npm run verify
```

Root verification runs workspace checks where packages define them, then checks Markdown/JSON/YAML formatting with Prettier.

## Pi package conventions

See [`docs/pi-packages.md`](docs/pi-packages.md).

Short version:

- publishable packages live under `packages/<name>/`
- package manifests include the `pi-package` keyword for discoverability
- package manifests declare Pi resources under the `pi` key when conventional directories are not enough
- runtime dependencies live in the package that uses them
- Pi-provided APIs such as `@mariozechner/pi-coding-agent` and `typebox` should usually be peer dependencies

## Publishing

See [`docs/publishing.md`](docs/publishing.md).

Tokens must come from AWS SSM Parameter Store or local environment variables. Never commit tokens, `.npmrc`, or generated auth files.

## License

This repo is a container for multiple packages. Package-level `package.json` and `LICENSE` files govern package code. See [`LICENSE`](LICENSE) for the repo-level licensing note.
