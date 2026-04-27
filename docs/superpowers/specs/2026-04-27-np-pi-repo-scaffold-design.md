# np-pi Repository Scaffold Design

## Goal

Create the initial public repository scaffold for `Neural-Partners/np-pi`, a home for Neural Partners Pi packages, extensions, skills, prompts, themes, and supporting docs.

The scaffold must support public npm-published Pi packages now, private/local Pi work later, and a separate agent-owned migration of `@neuralpartners/pi-yo` into this repo without path collisions.

## Current State

- Local repo: `/Users/scottblodgett/Projects/personal/np-pi`
- Remote: `https://github.com/Neural-Partners/np-pi.git`
- Branch: `main`
- Repo currently has no committed files.
- `@neuralpartners/pi-yo` is currently published on npm as version `0.1.2` and remains in the separate `neural-os` repo for now.
- Another Pi session is responsible for the `pi-yo` migration and verification.

## Approved Approach

Use a private npm workspace monorepo.

This gives each public Pi package an independent package directory and version while keeping shared repo-level tooling simple. It also leaves a clean split between public publishable packages and gitignored local/private experiments.

Rejected alternatives:

- Single root Pi package: too cramped once more than one package needs its own version or release cadence.
- Hybrid root Pi bundle plus packages: powerful but easy to confuse during install and publishing.

## Repository Layout

```txt
np-pi/
├─ package.json
├─ package-lock.json
├─ tsconfig.base.json
├─ README.md
├─ LICENSE
├─ .gitignore
├─ .npmrc.example
├─ .github/
│  └─ workflows/
│     └─ ci.yml
├─ docs/
│  ├─ pi-packages.md
│  ├─ publishing.md
│  └─ superpowers/
│     ├─ specs/
│     └─ plans/
├─ packages/
│  └─ README.md
├─ local/
│  └─ README.md
└─ private/
   └─ README.md
```

### Root Files

- `package.json`
  - `private: true`
  - `type: module`
  - `workspaces: ["packages/*"]`
  - root scripts for `verify`, `test`, `lint`, `typecheck`, `format:check`, and `clean`
  - no publishable root package
- `package-lock.json`
  - npm workspace lockfile generated from the root install
- `tsconfig.base.json`
  - shared TypeScript defaults for future packages
  - package-level `tsconfig.json` files can extend this file later
- `README.md`
  - explains repo purpose, public/private split, package locations, and development commands
- `LICENSE`
  - repo-level default license statement
  - individual packages may override with their own license files and `package.json` license fields
- `.gitignore`
  - ignores build artifacts, dependency folders, env files, local caches, and private package areas
- `.npmrc.example`
  - documents npm auth configuration without storing tokens

### Public Package Area

`packages/*` is reserved for public, publishable Pi/npm packages.

Examples:

```txt
packages/my-extension-package/
packages/my-skill-package/
packages/pi-yo/
```

`packages/pi-yo/` is intentionally reserved for the separate pi-yo migration session. This scaffold will not create or modify that path.

Each package should own its own:

- `package.json`
- `README.md`
- `LICENSE` when package licensing differs from the repo default
- `extensions/`, `skills/`, `prompts/`, or `themes/` resources as appropriate
- tests and verification scripts

Pi package manifests should use `package.json` `pi` metadata, for example:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

### Private and Local Package Areas

`local/` and `private/` are for non-public work and must be ignored by git except for their README placeholders.

Use cases:

- personal experiments
- Neural Partners internal-only packages
- customer-specific extensions or skills
- scratch Pi resources not ready for publication

This keeps the public repo useful while reducing the chance of accidentally committing private code.

## Dependencies and Tooling

Use npm workspaces because the existing `pi-yo` package uses npm and `package-lock.json`.

Root dev dependencies should stay minimal:

- `typescript` for shared typechecking conventions
- `prettier` for consistent markdown/json/yaml formatting

No runtime dependencies belong at the root. Runtime dependencies belong inside the package that uses them.

Pi extension packages that import Pi APIs should list Pi-provided packages as peer dependencies rather than bundling them:

- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-tui`
- `typebox`

Version ranges should be chosen per package based on tested compatibility.

## Scripts

Root scripts should be safe when no packages exist yet.

Recommended root scripts:

```json
{
  "scripts": {
    "verify": "npm run typecheck --if-present --workspaces && npm run test --if-present --workspaces && npm run lint --if-present --workspaces && npm run format:check",
    "test": "npm run test --if-present --workspaces",
    "typecheck": "npm run typecheck --if-present --workspaces",
    "lint": "npm run lint --if-present --workspaces",
    "format:check": "prettier --check .",
    "format": "prettier --write .",
    "clean": "git clean -fdX"
  }
}
```

The root `verify` command should run cleanly before and after package migration.

## CI Design

Create `.github/workflows/ci.yml` for pull requests and pushes to `main`.

CI should:

1. check out the repo
2. set up Node.js 22
3. run `npm ci`
4. run `npm run verify`

CI should not publish packages yet. Publishing should be added separately after release policy is explicit.

## Publishing and Secrets

Do not commit tokens, `.npmrc`, or generated auth files.

Document the existing AWS SSM Parameter Store secrets:

- GitHub PAT: `arn:aws:ssm:us-east-1:047719662689:parameter/np/prod/github-pat`
- NPM PAT: `arn:aws:ssm:us-east-1:047719662689:parameter/np/npm/access-token`

Local retrieval should use AWS profile `scott`:

```bash
aws ssm get-parameter \
  --profile scott \
  --region us-east-1 \
  --name /np/npm/access-token \
  --with-decryption \
  --query Parameter.Value \
  --output text
```

Docs should show safe examples that export tokens into the current shell or write temporary local auth files that remain gitignored.

## Pi Resource Conventions

Use Pi package conventions from the official docs:

- `extensions/` for TypeScript or JavaScript extensions
- `skills/` for Agent Skills directories containing `SKILL.md`
- `prompts/` for prompt templates
- `themes/` for JSON themes
- `package.json` `pi` manifest for explicit resource paths
- `pi-package` keyword for package gallery discoverability

For skills:

- skill names must be lowercase, hyphenated, and match the parent directory
- each skill directory must contain `SKILL.md`
- skill descriptions should state exactly when the skill should be used

For extensions:

- small extensions may be single files
- larger extensions should use `extensions/<name>/index.ts`
- extension packages should keep runtime dependencies in package-level `dependencies`
- package tests should verify core logic without requiring Pi interactive mode when possible

## Coordination Boundary

This scaffold must not create or modify:

- `packages/pi-yo/`
- any files copied from `../neural-os/packages/pi-yo`
- npm publishing automation for `@neuralpartners/pi-yo`

The other session owns the `pi-yo` migration and verification.

## Verification

After scaffolding, run:

```bash
npm install
npm run verify
find . -maxdepth 3 -type f | sort
```

Expected results:

- npm install succeeds and creates `package-lock.json`
- root verification succeeds with no packages present or with non-conflicting packages present
- generated file list contains docs and scaffold files only
- no `packages/pi-yo/` path exists unless the migration session created it
- no secrets or token values appear in tracked files

## Future Work

Future work should be separate from this scaffold:

- migrate `@neuralpartners/pi-yo` into `packages/pi-yo/`
- add publishing workflows once release policy is explicit
- add package templates for extensions and skills
- add repo-level release tooling if multiple public packages need coordinated versioning
