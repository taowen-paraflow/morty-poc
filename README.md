# morty-poc

One button starts [Claude Code](https://docs.claude.com/en/docs/claude-code) on a GitHub Actions
runner, connects it to [Morty](https://morty.build), and gives you a link that opens the
conversation in morty.build.

The launcher page is only a front door. Chat happens in Morty's web app; the runner is the
"computer" Morty relays to. Runners accept no inbound connections, which is fine: the Morty
daemon only dials out.

## What the user does

1. Press **Start**.
2. First time only: press **Create token**. GitHub opens a pre-filled fine-grained token form
   (Actions and Issues: read and write, 90 days); choose *Only select repositories* → this
   repository, generate it, and paste it back. It is kept encrypted in this browser.
3. Sign in to Claude when asked, and paste the code Claude shows (first time only; the
   resulting token is kept encrypted in this browser and reused).
4. Press **Open in Morty**.

The runner stops after 30 idle minutes, at 340 minutes (GitHub-hosted jobs end at 6 hours), or
when you press **Stop runner** (shift-click to force stop).

## How it works

```
launcher page ──workflow_dispatch──▶ runner.yml (GitHub Actions)
      ▲  │                                  │ claude setup-token / claude -p / morty setup
      │  └──── comments on issue "morty-run <id>" (secrets encrypted) ───┘
      │
      └── "Open in Morty" ──▶ https://morty.build/continue#code=…  ◀── Morty daemon on the runner
```

- **GitHub access** is a fine-grained token limited to this repository, created from GitHub's
  [template URL](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
  so only the repository has to be chosen. The page calls the GitHub REST API directly; no
  server is involved.
- **Messages** between page and runner are comments on a per-run issue. The page sends its RSA
  public key with the dispatch; the runner posts its own public key first. Every secret (Claude
  sign-in link and code, Claude token, Morty continue link) is encrypted to the receiver
  (RSA-OAEP-SHA256 wrapping AES-256-GCM). The runner only accepts comments from the user who
  dispatched the run.
- **Claude sign-in** runs the official `claude setup-token` on the runner in a pseudo-terminal
  (`scripts/claude_login.py`), reading its full-screen UI through the `pyte` terminal emulator. Its long-lived token is returned to the page, encrypted, and kept
  in IndexedDB under a non-extractable key, so later launches skip this step.
- **Morty**: the runner continues the last Claude Code session (or starts one), runs
  `morty setup --harness claude`, and returns the continue link.
- **Continuity**: Claude Code's history (`~/.claude`) and the Morty identity are saved to the
  Actions cache when the runner ends (idle, time limit, failure, or **Stop runner**; not force
  stop), so every run is the same Morty computer with the same Recent list. The cache only holds
  an archive encrypted with a key that stays in the browser; the runner gets it per run,
  encrypted. **Forget saved data** drops the key, which makes saved conversations unreadable.

## Deploy your own

1. Fork this repository, enable Issues, and set *Settings → Pages → Source* to **GitHub Actions**.
   `pages.yml` runs the self-test and deploys the page on every push to `main`.
2. Set `repository` in `config.js` to your fork.

No server and no repository secrets are needed: GitHub access comes from your token and the
Claude account from your sign-in.

## Security notes

- Whoever opens a continue link controls the runner's Claude Code session, which can run
  commands on the runner with the job's `GITHUB_TOKEN` (contents read, issues write).
- Only users who can dispatch workflows in the repository can start runners.
- Keep the token limited to this repository. Encrypted messages are public comments; without the right private key they reveal only the
  run id and message type.
- Conversation history is cached only in encrypted form; the Claude token is never cached. Caches
  unused for 7 days are evicted by GitHub. Pull requests are disabled on this repository so fork
  workflows cannot read caches; enable that on your fork too.
- The Morty computer persists across runs. Revoke its access from morty.build if needed.

## Tests

`node test/selftest.mjs` (needs `pip install pyte`) checks that the page and runner halves of the encryption and message
format agree, and drives `scripts/claude_login.py` against a stand-in `claude setup-token`.

## License

MIT
