# Atlas (personal fork)

A stripped-down, macOS-only fork of [T3 Code](https://github.com/pingdotgg/t3code) — an "agent
harness control surface" that wraps provider CLIs behind a desktop GUI. This fork ships as **Atlas**.

This fork exists to be customized, not distributed. Relative to upstream it drops everything that
served other platforms or the hosted product:

- **No T3 Connect.** No Clerk sign-in, relay, managed tunnel, or hosted web app. Connecting to an
  environment is local pairing only.
- **No self-update or background service.** Both installed `t3@<version>` from npm, which would
  replace this fork with upstream. Build and run this repo instead.
- **macOS only.** The WSL backend and Linux password-store integration are gone, as are the mobile
  app, the marketing site, and the release/CI pipeline.
- **Two providers**: Codex and Claude Code. Cursor, Grok, and OpenCode adapters are removed.

What's kept: the server, the web UI, the Electron desktop shell, local pairing auth, SSH-managed
remote environments, and Tailscale Serve.

## Requirements

- macOS
- Node.js `^24.13.1` (the version the workspace pins)
- [Vite+](https://viteplus.dev/guide/) (`vp`): `curl -fsSL https://vite.plus | bash`
- At least one provider CLI installed and authenticated:
  - Codex: [Codex CLI](https://developers.openai.com/codex/cli), then `codex login`
  - Claude: [Claude Code](https://claude.com/product/claude-code), then `claude auth login`

## Running it

```bash
vp i          # install dependencies
vp run dev    # server + web, with a local pairing URL printed on startup
```

Other useful targets:

```bash
vp run dev:desktop        # Electron shell against the dev server
vp run typecheck          # tsgo across every workspace
vp run test               # full test suite
vp run dist:desktop:dmg   # build a signed-less macOS .dmg
```

## Documentation

Docs live in [docs/](./docs).

- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Link a project to another codebase](./docs/user/linked-projects.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from another machine](./docs/user/remote-access.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) ·
  [Claude](./docs/user/providers-claude.md)

Architecture starts at [docs/internals/overview.md](./docs/internals/overview.md).

## License

Upstream's license applies; see [LICENSE](./LICENSE).
