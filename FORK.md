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

- **Accounts page.** Usage is attributed to the stored credential that served each request. Logins of one provider that belong to
  the same person (same email and organisation) are merged into one account, with its status (active, blocked, needs login), its
  active rate-limit blocks, its latest quota readings, and how requests are split between accounts over time. Requests that are
  not tied to an account (background calls, API keys, gateways) are counted separately, so the per-account numbers add up to each
  provider's total. API: `GET /api/stats/accounts`, `GET /api/stats/accounts/flow`. There is also a small Accounts card on the
  Overview page.
- **Live traffic page.** Which sessions are sending requests to which account right now: sessions grouped with their subagents,
  accounts and API-key gateways (from `models.yml`), a line per session and target, solid for traffic in the last minute and dashed
  for the last five minutes. Subagent cards show their state and the tool they started last. API: `GET /api/stats/live`, polled
  every two seconds. It reads only your own session logs and `agent.db`; tool arguments are never stored.
- **Hub pages: Sessions, Relay, Alerts and Pair.** These pages control omp sessions through a local "hub" (list, stop the running
  turn, rename, end, start a session in a chosen folder, open a session through a private relay, push alerts, pair a browser).
  They call the hub's `/api/hub/*` API from the same origin. With a plain `omp stats` there is no hub (those requests get 404), so
  these pages have nothing to show; the other pages are not affected. For the proxy mode see `packages/stats/src/proxy-gate.ts`: with
  `OMP_STATS_PROXY_KEY_FILE=<file>` set, the dashboard answers only a local proxy that signs each request with that key.
  Without the variable the dashboard behaves like upstream.

The dashboard of the companion project [omp-tether](https://github.com/saadsoft1993/omp-tether) (`omp-dashboard`) is derived from
these hub pages; it has its own server and its own API (see its documentation) and does not proxy `omp stats`.

Branches:

| Branch | Content |
| --- | --- |
| `insights` (default) | everything below plus this file |
| `local-dashboard` | `stats-live-traffic` plus the hub pages and the machine banner |
| `stats-live-traffic` | `stats-account-attribution` plus the Live traffic page |
| `stats-account-attribution` | upstream `f2b795ba74` plus the Accounts page |
| `main` | mirror of upstream `main`; do not commit to it |

Each branch builds on the previous one, so `git diff main..insights -- packages/stats` shows all changes. Upstream's own branches
were copied into this fork when it was created and are not used here.

## Run it

You need [Bun](https://bun.sh) 1.4.4 or newer (the repository pins `bun@>=1.4.4`) and the native addon for your platform.
This was tried with Bun 1.4.4 on macOS (Apple silicon).

```bash
# A shallow clone is enough to run it and much faster: a full clone of this repository carries upstream's whole history
# (a full clone stalled for 15 minutes on one machine, a shallow one took about 30 seconds).
git clone --depth 1 https://github.com/saadsoft1993/omp-insights.git
cd omp-insights

# 1. Dependencies. --ignore-scripts skips the repository's "prepare" step, which regenerates the HTML export viewer
#    (not needed for the dashboard). Without the flag: leave the CI variable unset, and on macOS undo the rewrite
#    of packages/coding-agent/src/export/html/viewer.generated.json afterwards with `git checkout` on that file.
bun install --frozen-lockfile --ignore-scripts

# 2. Native addon (see below), then:
bun packages/stats/src/index.ts --port 3847      # the dashboard on its own
bun packages/coding-agent/src/cli.ts stats --port 3847   # the same through the omp CLI (what `omp stats` runs)
```

Open the printed `http://127.0.0.1:<port>` address. The dashboard reads `~/.omp/agent/sessions/` and `~/.omp/agent/agent.db`, keeps
its own database in `~/.omp/stats.db`, and listens on `127.0.0.1` unless you pass `--host`. Other options: `--json` (print the
statistics and exit), `--sync` (ingest sessions and print a summary), `--help`. The page client is built from source when the
server starts, so there is no separate build step. A one-time re-parse of your history fills in the account attribution the
first time a database from before this fork is opened.

To try it without touching your own data, run it with a scratch home directory and a free port:

```bash
HOME=$(mktemp -d) bun packages/stats/src/index.ts --port 0
```

### Native addon

omp's core pieces (file search, SQLite locking and more) are a native (Rust) addon. Nothing starts without it (the error is
`Failed to load pi_natives native addon`). Pick one:

- **Download the published addon** (no Rust needed). The version must match the repository's `packages/natives/package.json`
  (`18.18.0` at this fork's base). Replace `darwin-arm64` with your platform and architecture (the packages are listed as `@oh-my-pi/pi-natives-*` on npm):

  ```bash
  cd "$(mktemp -d)" && npm pack @oh-my-pi/pi-natives-darwin-arm64@18.18.0 && tar xzf oh-my-pi-pi-natives-*.tgz
  cp package/*.node /path/to/omp-insights/packages/natives/native/
  ```

  On x64 Linux copy every `*.node` file; the loader picks the `baseline` or `modern` variant itself.
- **Build it** from source: `bun run build` in `packages/natives`. This needs the pinned Rust toolchain from
  `rust-toolchain.toml`. (Not tried for this fork's documentation; follow upstream's `packages/natives/README.md`.)

## Checks

```bash
cd packages/stats
bun run check        # oxlint, oxfmt, type checks for the server and for the page
bun test             # 283 tests on the `insights` branch (245 on stats-account-attribution, 262 on stats-live-traffic)
```

`bun test` needs the native addon (see above). Point `HOME` at a scratch directory if you do not want the tests near your own
`~/.omp`.

## Relation to upstream

This fork follows upstream; it does not replace it. Changes that are useful to everyone are meant to go to upstream as pull
requests, in small pieces. **None has been opened yet**, and this fork makes no claim that upstream will take them. Please do not
report problems with this fork to the upstream project; open an issue or a pull request here.

### Keep up with upstream

```bash
git remote add upstream https://github.com/can1357/oh-my-pi.git
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
# then move the feature branches one after the other, bottom to top:
git checkout stats-account-attribution && git rebase upstream/main
git checkout stats-live-traffic        && git rebase --onto stats-account-attribution <old-account-tip>
git checkout local-dashboard           && git rebase --onto stats-live-traffic <old-live-tip>
git checkout insights                  && git rebase --onto local-dashboard <old-hub-tip>
```

Use `git rev-parse <branch>` before the first rebase to note each old tip. Then run `bun install`, the checks above, and push with
`git push --force-with-lease`. Most conflicts will be in `packages/stats/src/server.ts`, `db.ts` and `client/App.tsx`.
A shallow clone cannot rebase onto upstream's history: run `git fetch --unshallow` (or clone without `--depth`) before you do this.

## Related projects

- [omp-tether](https://github.com/saadsoft1993/omp-tether): plugins for omp that let you reach your own sessions from other
  places on your own machines (session control, background services, a private relay, a local dashboard).
- [omp-hindsight-guard](https://github.com/saadsoft1993/omp-hindsight-guard): a redacting proxy, per-folder memory banks and a
  one-time importer for a self-run Hindsight memory server used with omp.

## Contributing

Pull requests to this fork are welcome: one logical change per pull request, based on `insights`, with tests (`bun test` in
`packages/stats`) and a clean `bun run check`. Keep user-visible changes in `packages/stats/CHANGELOG.md`. Do not put personal
paths, host names, account names or keys in code, tests or documentation; the tests use fictional data. Upstream's
[`CONTRIBUTING.md`](CONTRIBUTING.md) describes the code style of the project; its rule about discussing large changes first in
Discord applies to upstream, not to this fork.

Security problems: use GitHub's private vulnerability reporting on this repository rather than a public issue. Problems that
are in upstream code should be reported to upstream.
