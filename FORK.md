# omp-insights

omp-insights is a **modified fork** of [omp](https://github.com/can1357/oh-my-pi) (Oh My Pi). It is not the official omp and is
not supported by its authors. Every change is inside `packages/stats` (the `omp stats` dashboard); the agent, the CLI, the
native code and everything else are the upstream files, unchanged. The binary and package names are still `omp` and
`@oh-my-pi/*`, so that the code stays easy to compare with upstream.

Original authors and licence: omp is by Mario Zechner (the [Pi](https://github.com/badlogic/pi-mono) project), Can Bölük and
Stencil Labs, Inc., under the MIT licence. [`LICENSE`](LICENSE), `packages/coding-agent/THIRD-PARTY-NOTICES.txt` and the licence
files of every package and crate are kept as they are. The changes in this fork are released under the same MIT licence.

## What this fork adds

All of it lives in the stats dashboard (`omp stats`):

- **Accounts page** (`g a`). Usage is attributed to the stored credential that served each request. Logins of one provider that
  belong to the same person (same email and organisation) are merged into one account, with its status (active, blocked, needs
  login), its active rate-limit blocks, its latest quota readings, and how requests are split between accounts over time.
  Requests that are not tied to an account (background calls, API keys, gateways) are counted separately, so the per-account
  numbers add up to each provider's total. API: `GET /api/stats/accounts`, `GET /api/stats/accounts/flow`. There is also a small
  Accounts card on the Overview page.
- **Live page** (`g v`). Which sessions are sending requests to which account right now: sessions grouped with their subagents,
  accounts and API-key gateways (from `models.yml`), a line per session and target, solid for traffic in the last minute and
  dashed for the last five minutes. Subagent cards show their state and the tool they started last. API: `GET /api/stats/live`,
  polled every two seconds. It reads only your own session logs and `agent.db`; tool arguments are never stored.
- **Hub pages** in a Control group: **Sessions** (list, stop the running turn, rename, end, start a session in a chosen folder,
  change a session's model, thinking level, plan mode or goal, answer an open plan review, a terminal panel and a quota card),
  **Relay** (open a session through a private relay), **Alerts** (phone alerts), **Jobs** (the background jobs the hub watches,
  with schedule, status and last log write) and **Devices** (paired browsers and pairing links), plus a **Pair** screen for
  browsers that are not paired yet. These pages, and the report pages of a **Control center** group, call a local "hub" through its
  `/api/hub/*` API from the same origin. With a plain `omp stats` there is no hub, so the dashboard hides them; the other pages
  are not affected.
- **Proxy mode** (see `packages/stats/src/proxy-gate.ts`). It works only when the dashboard is started through the stats
  package's own entrypoint, for example
  `OMP_STATS_PROXY_KEY_FILE=/path/to/key bun packages/stats/src/index.ts --port 3847`. The dashboard then answers only a local
  proxy that signs each request with that file's key. Plain `omp stats` (and `bun packages/coding-agent/src/cli.ts stats`)
  ignores the variable and serves the dashboard without the check. Without the variable the dashboard behaves like upstream.
- **Machine banner and installable app.** The header shows which machine the hub runs on, and the page can be installed to a
  phone's or tablet's Home Screen (web app manifest and icons).

The maintainer's own build also has a Memory page. It is **not part of this fork** and is left out of every published version.

The dashboard of the companion project [omp-tether](https://github.com/saadsoft1993/omp-tether) (`omp-dashboard`) is derived from
these hub pages; it has its own server and its own API (see its documentation) and does not proxy `omp stats`.

Branches:

| Branch | Content |
| --- | --- |
| `insights` (default) | the published fork: upstream plus the dashboard above and this file |
| `main` | an old copy of upstream `main`; it is not updated |

To see the dashboard changes, compare `packages/stats` with the upstream commit that `insights` last merged (the second parent
of its newest merge commit). Other branches in this repository are older snapshots and are not updated.

## Run the dashboard yourself

You need git, [Bun](https://bun.sh) 1.4.4 or newer (the repository pins `bun@>=1.4.4`), npm (only to download the native
addon) and `tar`. Tested with Bun 1.4.4 on Linux x64 and macOS arm64; other platforms are untested.

```bash
# A shallow clone is enough and much faster: a full clone carries upstream's whole history.
git clone --depth 1 --branch insights https://github.com/saadsoft1993/omp-insights.git
cd omp-insights

# 1. Dependencies. --ignore-scripts skips the repository's "prepare" step, which regenerates the HTML export viewer
#    (not needed for the dashboard).
bun install --frozen-lockfile --ignore-scripts

# 2. The native addon for your platform, at the version the repository pins. <platform> is darwin-arm64, darwin-x64,
#    linux-x64 or linux-arm64 (the packages are listed as @oh-my-pi/pi-natives-* on npm).
platform=linux-x64
version=$(bun -e 'console.log(require("./packages/natives/package.json").version)')
repo=$PWD
(cd "$(mktemp -d)" && npm pack --silent "@oh-my-pi/pi-natives-$platform@$version" &&
  tar xzf oh-my-pi-pi-natives-*.tgz && cp package/pi_natives.*.node "$repo/packages/natives/native/")

# 3. The dashboard.
bun packages/stats/src/index.ts --port 3850 --host 127.0.0.1
```

Open `http://127.0.0.1:3850`. On x64 the addon package holds a `baseline` and a `modern` build; copy both, the loader picks
one. Without the addon nothing starts (the error is `Failed to load pi_natives native addon`). You can also build it from
source with `bun run build` in `packages/natives`, which needs the pinned Rust toolchain from `rust-toolchain.toml` (not tried
for this fork; see upstream's `packages/natives/README.md`).

The dashboard reads `~/.omp/agent/sessions/` and `~/.omp/agent/agent.db`, keeps its own database in `~/.omp/stats.db`, and
listens on `127.0.0.1` unless you pass another `--host`. `bun packages/coding-agent/src/cli.ts stats --port 3850` runs the
same dashboard through the omp CLI (what `omp stats` runs). Other options: `--json` (print the statistics and exit), `--sync`
(ingest sessions and print a summary), `--help`. The page client is built from source when the server starts, so there is no
separate build step. A one-time re-parse of your history fills in the account attribution the first time a database from
before this fork is opened.

The Usage, Activity and Insights pages work on their own. The Control, Control center and Settings pages appear only when the
dashboard is served behind an omp hub; without one they are hidden.

To try it without touching your own data, use a scratch home directory:

```bash
HOME=$(mktemp -d) bun packages/stats/src/index.ts --port 3850 --host 127.0.0.1
```

## Checks

```bash
cd packages/stats
bun run check        # oxlint, oxfmt, type checks for the server and for the page
bun test
```

`bun test` needs the native addon (see "Run the dashboard yourself"). Point `HOME` at a scratch directory if you do not want the tests near your own
`~/.omp`.

## Relation to upstream

This fork follows upstream; it does not replace it. Changes that are useful to everyone are meant to go to upstream as pull
requests, in small pieces. **None has been opened yet**, and this fork makes no claim that upstream will take them. Please do not
report problems with this fork to the upstream project; open an issue or a pull request here.

### Keep up with upstream

The maintainer publishes `insights` from a private integration branch. Each update merges a newer upstream commit (one whose
native addon is already on npm) and, when the dashboard changed, adds one commit with the new dashboard on top. Every published
commit passes the checks above first. `insights` only moves forward: it is never rebased or force-pushed, so a plain
`git pull` keeps a clone current.

## Related projects

- [omp-tether](https://github.com/saadsoft1993/omp-tether): plugins for omp that let you reach your own sessions from other
  places on your own machines (session control, background services, a private relay, a local dashboard).

## Contributing

Issues and pull requests are welcome: one logical change per pull request, against `insights`, with tests (`bun test` in
`packages/stats`) and a clean `bun run check`. Because `insights` is published from a private integration branch, a pull request
is not merged as it is: its change is ported by hand and then appears in the next published commit. Keep user-visible changes in
`packages/stats/CHANGELOG.md`. Do not put personal paths, host names, account names or keys in code, tests or documentation; the
tests use fictional data. Upstream's [`CONTRIBUTING.md`](CONTRIBUTING.md) describes the code style of the project; its rule
about discussing large changes first in Discord applies to upstream, not to this fork.

Security problems: use GitHub's private vulnerability reporting on this repository rather than a public issue. Problems that
are in upstream code should be reported to upstream.
