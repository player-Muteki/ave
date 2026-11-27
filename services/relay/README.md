# AVE Relay Service Boundary (`services/relay`)

Status: **Optional future capability — deferred from v1 local closed loop (per ADR 012)**

Per ADR 012 ("先做认证直连，再决定是否实现 E2EE relay"), v1 remote access uses direct authenticated TLS/WebSocket connectivity between `apps/mobile/` (Expo Android supervisor) and `services/daemon/` (`localOwner` or paired-device tokens issued via `video.v1.create_invitation` / `video.v1.redeem_invitation`).

If remote connectivity outside LAN/VPN is added in a future release, this directory will host a zero-knowledge ciphertext relay obeying these hard constraints:
- **Ciphertext-only forwarding**: The relay routes authenticated, end-to-end encrypted frames between paired mobile clients and a desktop daemon without possessing plaintext keys, media assets, prompts, or SQLite state.
- **No domain authority**: Approvals, grants, jobs, and CAS writes remain exclusively inside `services/daemon/` + `storage/sqlite/`.
- **Non-dependency**: `services/daemon/`, `apps/desktop/`, `apps/web/`, and `apps/mobile/` never depend on `services/relay/` for local execution.
