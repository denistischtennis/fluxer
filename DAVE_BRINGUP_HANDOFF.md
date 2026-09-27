# DAVE Integration — Status & verbleibende Arbeit

Stand: 2026-09-27 (nach Bring-Up + Clean-Cutover). Repo: `C:/Users/Main/Desktop/fluxer-main`
Container: `fluxer-dev-workspace-1` (Compose `.devcontainer/docker-compose.yml`)

---

## 1. Task 1 — Stack hoch + Fix B: **ERLEDIGT und live verifiziert**

VM/Stack nach Neustart wieder online (Warmer Cache: pnpm 4s, rspack 116s).

**Fix B (libdave WASM Asset-Emission) bestätigt:**

| Check | Ergebnis |
|---|---|
| Emittiertes Asset im Bundle | `assets/libdave.3176ae92b1dc6d1e.wasm` |
| HTTP | 200, `content-type: application/wasm` |
| Größe | 2 318 923 B = Quell-Artefakt |
| Magic | `0061 736d 0100 0000` |
| SHA-256 | identisch zu `packages/libdave/wasm-web/libdave.wasm` (`f989f2e9…8631e83`) |
| Referenz im Code | Chunk `assets/packages_libdave_js_wasm-web_ts.js` **und** `assets/livekit-e2ee.worker.js` zeigen auf die gehashte URL |
| Gegenprobe Alt-Fehlermodus | `/libdave.wasm` liefert weiter SPA-Fallback (`text/html`, 6252 B) — wird nicht mehr referenziert |

Verifikations-Kommandos (im Container):
```bash
curl -sS http://127.0.0.1:8088/assets/packages_libdave_js_wasm-web_ts.js \
  | grep -aoE '[A-Za-z0-9./_-]+\.wasm' | sort -u
curl -sSI http://127.0.0.1:8088/assets/libdave.3176ae92b1dc6d1e.wasm | grep -i content-
sha256sum /tmp/dave5.wasm /workspaces/fluxer/packages/libdave/wasm-web/libdave.wasm
```

## 2. Task 3 — Clean Cutover (Plan Step 9): **ERLEDIGT**

Alte LiveKit-Shared-Key-Logik ist aus Gateway + App entfernt. Akzeptanz-Grep über
`fluxer_gateway/src` liefert **null Treffer** für: `e2ee_key`, `get_or_create_room_key`,
`forget_room_key`, `maybe_room_key`, `e2ee_room_keys`, `sweep_e2ee`, `clear_dm_e2ee`,
`maybe_attach_e2ee`.

Geänderte Dateien:

**Gateway — Key-Erzeugung/-Speicher/-Verteilung raus:**
- `guild/voice/guild_voice_e2ee.erl` — nur noch Policy-Gating (Feature-/Rollout-/Capability-Checks,
  `check_join_allowed_*`, `channel_is_e2ee_active*`, `join_downgrades_e2ee`). Keine Keys, keine Macros.
- `guild/voice/guild_voice_connection_util.erl` — `maybe_attach_e2ee_key_to_reply/2` → `snowflake_bin/1`.
- `guild/voice/guild_voice_connection_join.erl` — nutzt `guild_voice_dave:negotiate_join/4`.
- `guild/voice/guild_voice_connection_move.erl` — **NEU:** Channel-Move verhandelt jetzt selbst DAVE
  (`dave_version` im Move-Reply) und fährt den alten Channel per `retire_voice_states` zurück.
  Vorher: Move bekam einen Shared-Key, aber kein DAVE → nach Cutover sonst unverschlüsselter Move.
- `guild/voice/guild_voice_dave.erl` — neuer Export `negotiate_join/4` (Room-Lookup + drive_join +
  State-Rückgabe), damit Join und Move denselben Weg gehen.
- `guild/voice/guild_voice_disconnect_broadcast.erl` — umgeschrieben: `retire_voice_states/4`
  (member_left pro entferntem Voice-State + Raum-Verwurf, wenn Channel inkl. Pending leer ist).
  Alle `clear_e2ee_room_key*`-Funktionen weg.
- `guild/voice/guild_voice_disconnect_channel.erl`, `..._user.erl` — rufen `retire_voice_states/4`.
- `guild/voice/guild_voice_connection_pending.erl` — `clear_expired_e2ee_keys*` →
  `retire_expired_dave_rooms/2`; Export `clear_e2ee_room_key_if_channel_idle/3` entfernt.
- `guild/voice/guild_voice_server.erl` — Feld `e2ee_room_keys`, `sweep_e2ee_room_keys/1`,
  `MAX_E2EE_KEYS` entfernt; Test auf `dave_rooms`-Erhalt umgestellt.
- `guild/voice/guild_voice_server_state.erl` — **`dave_rooms` wandert jetzt durch
  `build_guild_state`/`merge_guild_state` durch** (vorher fehlte es dort komplett → Room-State wäre
  beim Round-Trip verloren gegangen).
- `guild/guild.erl` — `voice_guild_state_keys()` und Fixtures: `e2ee_room_keys` → `dave_rooms`.
- `session/session_voice_dispatch.erl` — `voice_server_update` trägt `dave_version` statt `e2ee_key`
  (inkl. Log-Zeile); Tests entsprechen umgestellt.
- `guild/voice/dm_voice_token.erl`, `dm_voice_state.erl` — DM-Key-Vergabe/-Clearing entfernt,
  `build_voice_server_update/4` ohne Key-Clause.

**App:**
- `features/voice/engine/VoiceE2EEKeyProvider.ts` — toter `createE2EEKeyProvider()` +
  `ExternalE2EEKeyProvider`-Import raus; Datei ist nur noch Worker-Erzeugung/-Lebenszyklus.
- `features/voice/engine/VoiceConnectionStateMachine.ts` — `e2ee_key` aus Payload-Typ und aus der
  `isRegionChange`-Bedingung entfernt (Key-Rotation läuft über MLS-Transitions, nicht über Grants).
- `features/voice/engine/v2/VoiceEngineV2AppAdapterAssertions.ts` — validiert `dave_version: number`
  statt `e2ee_key: string`.

**Doku:**
- `fluxer_docs/.../gateway/events.md`, `.../voice/index.md` — VOICE_SERVER_UPDATE beschreibt
  `dave_version` statt `e2ee_key`.

**Wichtig — Fund beim Cutover:** Vor diesem Schritt sendete das Gateway für **Guild**-Grants gar kein
`dave_version` (nur `e2ee_key`). Der Client schaltet DAVE aber nur bei `dave_version >= 1`
(`VoiceEngineV2AppConnectionHostAdapter.ts:170`). Ohne den Dispatch-Fix oben wäre Guild-DAVE also
niemals aktiv geworden. Jetzt gesetzt.

## 3. Verifikation nach Cutover

| Ebene | Ergebnis |
|---|---|
| `rebar3 compile` (Gateway) | grün |
| `rebar3 eunit` (20 berührte Module, inkl. DAVE-Core) | **186 Tests, 0 Failures** |
| `pnpm --filter @fluxer/dave test` | **24 Tests grün** |
| `vitest run src/features/voice/engine` (App) | **101 Tests grün** |
| `tsc --noEmit` (fluxer_app) | **0 Fehler** |
| Dev-Stack-Neustart auf Cutover-Code (`/tmp/dev6.log`) | Rspack compiled 139,6 s, **0** `Cannot find module '@fluxer…'`, Ports 3000/8080/8088/8771/8773 up |
| libdave-WASM-Asset nach Rebuild | `assets/libdave.3176ae92b1dc6d1e.wasm`, 2 318 923 B, Magic `0061736d`, SHA-256 = Quell-Artefakt |

Gelöschte Tests: die zwei DM-Tests, die das alte `dm_e2ee_room_keys`-Verhalten festgeschrieben haben
(`test/dm_voice_state_tests.erl`) — Verhalten existiert bewusst nicht mehr.

Zusätzlich behoben: `packages/libdave/js/wasm-web.ts` hatte `ReturnType<typeof …>`/`Parameters<…>[0]`
als veröffentlichte Typen (TS-Fehler beim Spread von `unknown` + Regelverstoß); jetzt benannte
Exporte `DaveModuleInit` / `LoadedDaveModule`.

## 4. DM-Call DAVE — implementiert

Architektur-Entscheidung: Der **Call-Prozess** (`call.erl`, via `call_manager:lookup/1`) ist der
einzige serialisierte Owner eines DM-Calls und damit das korrekte Zuhause für die MLS-Room —
analog zum `guild_voice_server` pro Guild-Channel. Die DM-Voice-State pro Session bleibt erhalten,
hält aber keine Krypto-Rooms.

Neu: **`src/call/call_dave.erl`** — hält die Room in `dave_rooms` des Call-States, keyed nach dem
Channel-id des Calls selbst (nicht nach etwas, was der Anrufer durchreicht). Alle drei Eingänge
(`negotiate_join/3`, `handle_message/3`, `member_left/2`) sind gekapselt: ein DAVE-Fehler wirft die
Call-Verwaltung nicht um, sondern liefert den unveränderten State zurück.

Verdrahtung:
- `call.erl` — neue Nachrichten `{dave_negotiate, UserBin, MaxVersion}` → `{ok, Version}` und
  `{dave_message, SenderBin, Raw}` → `ok`; Decoder-Arme + `call_request()`-Typ erweitert.
- `session_voice.erl` — Opcode 17 geht bei vorhandenem `guild_id` an den Guild-Voice-Server,
  sonst an den Call-Prozess der Channel-id.
- `call_voice.erl` — `member_left` hängt in `handle_leave`, `do_disconnect_cleanup` und
  `handle_session_down`. **Zusätzlich:** Region-Switch-Grants tragen jetzt `dave_version`
  (`dave_version_of/1` liest es aus der Room), damit ein mitten im Call neu ausgestellter Grant die
  Verbindung nicht still auf Klartext zurückfallen lässt.
- `dm_voice_token.erl` — beide Grant-Pfade (`handle_dm_token_success/2` und
  `handle_get_voice_token_ok/5`) verhandeln mit dem Call-Prozess und senden `dave_version`.
  **Fail-closed:** ist DAVE erzwungen und der Call-Owner antwortet nicht, wird der Grant mit
  `voice_token_failed` abgelehnt statt unverschlüsselt weiterzureichen.
- `dm_voice_connect.erl` / `session_voice_connect.erl` — `dave_max_version` wird durch die
  DM-Kette durchgereicht; `e2ee_capable` kommt jetzt aus `session_init:dave_capable/1` statt aus dem
  Client-Boolean.

Beim Bauen gefundener eigener Bug (durch eigenen Test aufgedeckt): `#{}` als Pattern matcht in Erlang
**jede** Map, nicht nur die leere — `call_dave:room/1` hätte damit immer `undefined` geliefert, was
Region-Switch-Grants fälschlich als „kein DAVE" ausgewiesen hätte. Behoben über `channel_key_safe/1`
+ `room_in/2`.

**Noch nicht live bestätigt:** ob der Call-Prozess in *jeder* realen Reihenfolge schon existiert,
wenn das Voice-Token gezogen wird. Fail-closed macht das sichtbar (Grant-Fehler + Log
`dm_voice_dave_negotiation_failed_refusing_grant`) statt es zu verschleiern. Task 2 muss das für
DM-Calls explizit mitprüfen.

**Verifikation DM-DAVE:**

| Ebene | Ergebnis |
|---|---|
| `rebar3 compile` | grün |
| `call_dave` | **7 Tests, 0 Failures** (inkl. Raum-Ablegung unter dem Call-Channel) |
| `dm_voice_token` / `dm_voice_state` | 3 / 14 Tests grün |
| `voice_dave_coordinator` / `voice_dave_host` | 11 / 17 Tests grün |
| `session_init` / `session_voice_dispatch` | 20 / 9 Tests grün |
| `call_tests` (isoliert) | 18 Tests grün |
| Dev-Stack mit DM-Code (`/tmp/dev7.log`) | Rspack compiled, **0** Modulfehler, alle Ports up, Gateway `_health/ready` = 200, 0 × `undef`/`badmatch`/`function_clause` im Log |

Umgebungs-Hinweis: Meck-Mocks brauchen auf dieser kalten Docker-VM teils über 5 s; der meck-basierte
`call_dave`-Test läuft deshalb jetzt über einen `{timeout, 180, _}`-Generator. Ohne das Budget bricht
EUnit ihn als „cancelled" ab statt ihn zu melden — dasselbe Bild zeigte die bereits bestehende
`guild_voice_dave`-Suite, also Umgebung, nicht Code.

## 5. Was noch NICHT erledigt ist

**Task 2 — Live-Zwei-Browser-Klickthrough (nur von dir im echten Browser ausführbar).**
Managed Chromium startet auf dieser VM nicht. Ablauf steht im Plan (`Verification` Pkt. 3):
Join → WS-Trace mit Opcode 17 → identische Room-Codes (20 Ziffern) → symmetrische Safety Numbers →
Dritter joined (neue Epoch, Ton ≤10s) → Kick = Stille → kein Klartext-Opus am RTC-Port.
Der `dave_version`-Fix aus Abschnitt 2 ist Voraussetzung dafür, dass überhaupt etwas verschlüsselt
wird; für DM-Calls gilt das ebenso seit Abschnitt 4.

1. **Vendored livekit-client: Shared-Key-Kette noch im Code.** `DataCryptor.ts` ist weiterhin
   referenziert (`e2ee.worker.ts:23`, Message-Encrypt/Decrypt in Zeile 162/177) und
   `useSharedKey`-Äste existieren in 4 Zweigen. Plan-Bedingung „löschen wenn unreferenziert" ist damit
   nicht erfüllt. Die Äste rauszuschneiden ist Eingriff in ~5 Stellen des Vendor-Workers ohne hier
   laufzeit-verifizierbar zu sein — bewusst zurückgestellt, bis Task 2 den DAVE-Pfad bestätigt hat.

2. **Zentrale `e2ee_capable`-Ableitung** (Plan Zeile 78) ist über `session_init:dave_capable/1`
   umgesetzt in `session_init`, `session_manager_shard_drain`, `guild_voice_connection_util` und
   `dm_voice_connect`; das client-seitig gesandte Boolean wird nicht mehr vertraut.

## 6. Umgebung — Gotchas (unverändert gültig)

- Bind-Mount verliert File-Events: nach Host-Edits an `packages/**` oder `rspack.config.mjs`
  Dev-Stack/rspack manuell neu starten.
- `cargo run -p fluxer-dev -- dev …` triggert `pnpm install` (heute: 4s, warm).
- Orchestrator reißt bei Readiness-Timeout alles ab → große `FLUXER_DEV_*_READY_TIMEOUT` setzen.
- `dave-fwd-proxy` (Host `127.0.0.1:8080`, Script `C:/Users/Main/dave-scratch/fwd_proxy.py`)
  muss laufen; nach Reboot separat starten.
- Snowflake-Service (`:8120/:8121`) läuft detached im Container, Log `/tmp/sf.log`.
- Dev-Stack dieser Session: Log `/tmp/dev6.log` (Neustart nach dem Cutover; nach DM-Änderungen
  erneut neu starten, damit der Gateway die neuen Beams lädt).

## 7. Schnelle Referenz

- Plan: `local://dave-protocol-integration-plan.md`
- Geändert (Gateway, Cutover): `guild_voice_e2ee`, `guild_voice_dave` (+`negotiate_join/4`),
  `guild_voice_connection_{join,move,util,pending}`, `guild_voice_disconnect_{broadcast,channel,user}`,
  `guild_voice_server`, `guild_voice_server_state`, `dm_voice_state`, `session_voice_dispatch`, `guild`
- Geändert (Gateway, DM-DAVE): **neu** `src/call/call_dave.erl`; `call.erl`, `call_voice.erl`,
  `session_voice.erl`, `session_voice_connect.erl`, `dm_voice.erl`, `dm_voice_token.erl`,
  `dm_voice_connect.erl`, `session_manager_shard_drain.erl`
- Geändert (App/Packages): `VoiceE2EEKeyProvider.ts`, `VoiceConnectionStateMachine.ts`,
  `VoiceEngineV2AppAdapterAssertions.ts`, `packages/libdave/js/wasm-web.ts`
- Port-Overrides: `.devcontainer/.env` (Postgres 15432, Valkey 16379, API 18080, rspack 13000, Proxy 8088)
