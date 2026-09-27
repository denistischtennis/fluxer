#!/usr/bin/env bash
# Unbounded DAVE dev-stack bring-up. Runs detached inside workspace container.
set -u
LOG=/tmp/dave_bringup.log
exec >"$LOG" 2>&1
echo "[bringup] start $(date)"

export FLUXER_DEV_API_READY_TIMEOUT=21600
export FLUXER_DEV_GATEWAY_READY_TIMEOUT=21600

# Phase 1: gateway compile (rebar, deps cached)
echo "[bringup] phase1 gateway compile $(date)"
( cd /workspaces/fluxer/fluxer_gateway && rebar3 compile )
GW=$?
echo "[bringup] gateway compile exit=$GW $(date)"
ls _build/default/lib/fluxer_gateway/ebin/*.beam >/dev/null 2>&1 || true
if [ "$GW" -ne 0 ]; then echo "[bringup] ABORT gateway compile failed"; exit 1; fi

# Phase 2: app-proxy cargo build (pre-warm so dev task starts fast)
echo "[bringup] phase2 app-proxy build $(date)"
( cd /workspaces/fluxer && cargo build -p fluxer_app_proxy )
AP=$?
echo "[bringup] app-proxy build exit=$AP $(date)"

# Phase 3: full dev stack (proxy api gateway-single app app-proxy)
echo "[bringup] phase3 dev stack $(date)"
( cd /workspaces/fluxer && cargo run -p fluxer-dev -- dev proxy api gateway-single app app-proxy )
DEV=$?
echo "[bringup] dev stack exit=$DEV $(date)"
