# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/shinichibi/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/shinichibi/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only. One in-memory store backs every surface, so the surfaces can never disagree: git smart HTTP (protocol v2 and v0 — advertisement, ls-refs, fetch with shallow support, receive-pack with report-status), the REST v3 API (repositories, contents, branches, commits, labels, issues, pull requests with squash merges), GraphQL v4 (queries, mutations, connections, introspection) and an MCP endpoint (JSON-RPC tools over the same store). Repository data is real git objects — commits made through the contents API are the commits a clone fetches. Timestamps come from a logical clock, so a replayed trial produces byte-identical results.

## Run it

```sh
npm start
```

The process reads `$MAKEFUN_ENV_URL` (the trial environment's origin) and `$MAKEFUN_SHOP_TOKEN` (the bearer token every API call must carry), registers its ephemeral port with the environment, and exits when the environment ends the trial. For local development both variables may be set to any local stand-in; with no token configured, requests are accepted unauthenticated.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
