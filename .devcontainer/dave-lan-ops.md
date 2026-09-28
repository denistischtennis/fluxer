# DAVE LAN Test Environment — Operations

Everything needed to bring up, restart, and probe the LAN-hosted stack used for
live two-browser DAVE (MLS) verification. All commands verified 2026-09-27/28.

## Topology

```
Browser (main machine)
  └─ https://192.168.1.212:443        Caddy container `dave-tls` (caddy:2)
       └─ workspace:8088               fluxer-dev `proxy` service (multiplexes
            ├─ app assets / WS         rspack dev server, gateway WebSocket,
            └─ /livekit                livekit signaling — all behind :8088)
Host services (compose project `fluxer-dev`, network fluxer-dev_default):
  postgres, valkey, nats (:4222), meilisearch, livekit, mailpit, workspace
Repo inside workspace container: /workspaces/fluxer
```

TLS cert: CN=fluxer-dev, SANs `IP:192.168.1.212, IP:10.136.24.45, DNS:localhost`,
valid until 2027-09. Files on host: `/tmp/fluxer-tls.crt`, `/tmp/fluxer-tls.key`
(mounted ro into dave-tls as `/certs/tls.{crt,key}`). Caddyfile: this dir's
`dave-lan.Caddyfile` (deployed copy at `/tmp/fluxer-caddy/Caddyfile`).

Regenerate cert (if expired) + recreate proxy:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout /tmp/fluxer-tls.key -out /tmp/fluxer-tls.crt \
  -subj "/CN=fluxer-dev" \
  -addext "subjectAltName=IP:192.168.1.212,IP:10.136.24.45,DNS:localhost"
docker run -d --name dave-tls --network fluxer-dev_default \
  -v /tmp/fluxer-caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /tmp/fluxer-tls.crt:/certs/tls.crt:ro \
  -v /tmp/fluxer-tls.key:/certs/tls.key:ro \
  -p 443:443 -p 443:443/udp caddy:2 \
  caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
```

## Bring-up / restart (REQUIRED after ANY gateway/Erlang change)

Client-only changes (`packages/dave`, `fluxer_app`) hot-serve via rspack watch —
just reload browsers. Gateway changes need the full sequence below because
in-memory NATS subscriber state (rollout config) is lost on restart.

```bash
# 1) Kill ALL stack procs in the workspace container. Include stray
#    target/debug/fluxer_app_proxy — it holds port 8773 and blocks relaunch.
docker exec fluxer-dev-workspace-1 bash -c \
  'ps aux | grep -E "fluxer|rspack|beam|node.*tsx|app_proxy|typed-css|weed" | grep -v grep | awk "{print \$2}" | xargs -r kill -9'

# 2) rust-services FIRST (users/messages/gifs/snowflakes/unfurl + weed storage), detached.
docker exec -d fluxer-dev-workspace-1 bash -c \
  'cd /workspaces/fluxer && cargo run -p fluxer-dev -- rust-services > /tmp/rust_servicesN.log 2>&1'
sleep 20   # let them bind; skipping this makes the main stack fail on connect

# 3) Main stack: proxy + api + gateway-single + app + app-proxy, detached.
docker exec -d fluxer-dev-workspace-1 bash -c \
  'cd /workspaces/fluxer && cargo run -p fluxer-dev -- dev proxy api gateway-single app app-proxy > /tmp/dev_mainN.log 2>&1'
```

Readiness = BOTH:

```bash
curl -sk -o /dev/null -w "%{http_code}\n" https://192.168.1.212/   # 200
docker exec fluxer-dev-workspace-1 grep -c "gateway started" /tmp/dev_mainN.log  # >=1
# and `ss -tlnp` in workspace shows fluxer-dev listening on 0.0.0.0:8088
```

## Rollout republish (MANDATORY after every gateway restart)

The test guild lacks the VOICE_E2EE feature flag; E2EE is enabled by pushing a
platform-wide rollout onto NATS (gateway keeps it in memory only):

```bash
python3 - <<'PYEOF'
import json, socket
payload = json.dumps({"type":"gateway_rollout_config","config":{"voice_e2ee_scope":"platform_wide"}}).encode()
s = socket.create_connection(("127.0.0.1", 4222), timeout=3)
s.sendall(b'CONNECT {"verbose":false,"pedantic":false}\r\n')
s.sendall(b'PUB config.gateway.rollout %d\r\n%s\r\n' % (len(payload), payload))
PYEOF
# confirm: grep -c "Gateway rollout config updated" /tmp/dev_mainN.log  → >=1
```

## Live probes

Room state (coordinator map keyed by channel binary; shows established/epoch/
key_packages/add_queue/transition phase):

```bash
erl -noshell -name daveprobe@127.0.0.1 -setcookie fluxer-dev
% Pid = rpc:call('fluxer_gateway@127.0.0.1', guild_voice_server, lookup, [1553847256862425088]),
% sys:get_state(Pid)  → field dave_rooms
```

DS sender-package signer RPC:

```bash
curl -X POST http://127.0.0.1:8080/internal/rpc \
  -H "x-fluxer-rpc-auth: dev-gateway-rpc-token" \
  -d '{"type":"dave_sender_package"}'
# expect ~176-char base64 ending "RkxVWEVSLURBVZS1FWFRFUk5BTC1TRUVERVI="
```

## Test identities

- Guild `1553847256862425088` ("test")
- Active voice channel **hgf = `1553898537484288000`** (old "d" deleted)
- Users: admin `1553846769626906624`, admin2 `1553853927110213632`
- MLS user ids are the raw snowflakes (libdave `std::stoull`); LiveKit identity
  `user_<snowflake>_<conn>` maps via `daveUserIdFromIdentity()` in the adapter.

## Pitfalls

- **After any root-run rebar3 in `dave-test`**: `chown -R 1000:1000
  /work/fluxer_gateway/_build` or the workspace gateway compile dies on rm perms.
  Run tests there with `--user root -e CARGO_HOME=/home/vscode/.cargo
  -e RUSTUP_HOME=/home/vscode/.rustup`.
- `push_utils_tests:get_default_avatar_url_test` fails ONLY in the LAN-overridden
  workspace container (LAN override changes the static CDN endpoint; the test
  hardcodes `http://localhost:8088`). Same test is green in a clean env
  (dave-test). Not a regression.
- Headless WASM repro pattern: throwaway `packages/dave/test/zz_*.test.ts` with
  `{DaveNodeModuleFactory} from '@fluxer/libdave/delivery'` + RecordingTransport;
  `pnpm vitest run test/zz_*.test.ts`; DELETE afterwards. Pipe C++ logs with
  `grep -E "\.cpp|SENT|THREW"`.
- Symptom glossary (console):
  - `Decrypt skipping silence of size: N` — peer cryptor lacks ratchet pre-establishment; benign.
  - `Duplicate encryption key` — self-add collision OR stale queued re-add of an existing member (fixed ff8d9aed5).
  - `Got proposal without MLS state` — stale client swap (fixed 413c60d39).
  - `must be for recognized user` — proposals raced ahead of LiveKit roster; deferred+retried (6e3692cc3).
  - `frame is not encrypted and pass through disabled` — transient during teardown windows.
- Healthy rejoin signatures in console: `proposals deferred … waiting for peer
  recognition` → `retrying deferred proposals after roster update` →
  ↑`commit_welcome` → `Successfully processed MLS commit … epoch N` → audio counters climb.
  `ignoring duplicate proposals bundle already processed` = dedup guard working.
