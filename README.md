# morty-poc

A proof of concept: a static GitHub Pages launcher starts a GitHub Actions runner that runs the
[Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), connects it to
[Morty](https://morty.build), and opens the conversation in morty.build in a new tab.

The launcher is only a front door. Chat happens in Morty's own web app; the runner is the "computer"
Morty relays to. Runners have no inbound network, which is fine: the Morty daemon only dials out.

## How it works

1. **Launch.** The page generates an RSA key pair in the browser and dispatches `runner.yml` with
   your fine-grained token, passing the public key and a request id.
2. **Runner.** The job installs Pi, writes its model configuration from repository secrets, starts a
   Pi session, and runs `morty setup`, which pairs the runner with Morty and returns a continue link.
3. **Handoff.** The link is a credential, so it is never logged. The runner encrypts it to the
   page's public key and posts the ciphertext as a comment on the `morty-poc handoffs` issue.
4. **Continue.** The page decrypts the link and opens `https://morty.build/continue…` in a new tab.
   Morty keeps that browser signed in for a day.
5. **Stop.** The job exits after the idle limit (default 30 minutes without Pi activity), at
   340 minutes (GitHub-hosted jobs end at 6 hours), or when you press **Stop** on the page, which
   cancels the run so its cleanup step revokes the runner's Morty access. **Force stop** ends a run
   that ignores cancel and skips that cleanup.

Only one runner runs at a time; another launch waits in the queue.

## Set up your own copy

1. Fork or copy this repository and enable GitHub Pages (Deploy from branch, `main`, `/`).
2. Add repository secrets with your Pi configuration (the contents of `~/.pi/agent/*.json`):
   `PI_MODELS_JSON`, `PI_AUTH_JSON`, `PI_SETTINGS_JSON`. The model endpoint must be reachable
   from GitHub-hosted runners.
3. Create a fine-grained token for this repository only, with **Actions: read and write** and
   **Issues: read**. Paste it into the page; "Remember" stores it in this browser's local storage.

To check the flow without a browser:

```sh
GITHUB_TOKEN=<token> node scripts/e2e.mjs <owner>/morty-poc
```

It launches a runner, redeems the link through the
[Morty agent API](https://morty.build/agent-api.md), runs one Pi turn, stops the run, and confirms
the cleanup revoked access.

## Security notes

- Whoever opens a continue link controls the runner's Pi session, which can run commands on the
  runner with the job's `GITHUB_TOKEN` (contents read, issues write) and your model key.
- Only users with write access can dispatch the workflow.
- Encrypted handoffs are public comments; without the page's private key they reveal nothing but
  the request id and run number.
- Conversation history lives on the runner and is lost when it stops. Persisting it (for example
  with the Actions cache) is not part of this proof of concept.

## License

MIT
