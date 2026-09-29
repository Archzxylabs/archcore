# ARCHcore Provider Agent Production Deployment Guide

This document describes production deployment and operational guarantees for the ARCHcore Provider Agent, specifically focusing on durable automatic-settlement state persistence and single-instance worker recovery.

---

## 1. Architectural Overview & Durable Transaction Journal

The Provider Agent colocates the node provider signer and physical compute machine. In addition to serving the authenticated renter inference gateway, the Provider Agent runs a background lifecycle watcher responsible for:
- Detecting incoming `RESERVED` rentals and calling `startRental(nodeId, rentalId)`.
- Detecting expired `ACTIVE` rentals and executing automatic `settleAfterExpiry(nodeId, rentalId)`.

### Settlement Journal (SQLite WAL)
Automatic settlement state transitions are persisted durably via the Node.js built-in `node:sqlite` transaction journal:
- **Development Default Database Path**: `apps/agent/data/settlement.sqlite`.
- **Recommended Production Path**: `/var/lib/archcore/settlement.sqlite` (active only when explicitly configured through `AGENT_SETTLEMENT_DB_PATH`).
- **Journal Mode**: `WAL` (`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`).
- **Schema Management**: Single table `settlement_jobs` versioned via `PRAGMA user_version = 2` with strict `CHECK` constraints on stages.
- **Single-Worker Lease Claims**: Uses a lease-based locking mechanism (`claimed_by`, `claim_expires_at_ms`) with configurable claim lease duration (`AGENT_SETTLE_CLAIM_LEASE_MS`, default 60000ms) to ensure exactly one settlement worker acts on a rental at a time.
- **Strict Monotonic Progress**: Job stages proceed monotonically: `PREPARING -> SUBMITTED -> MINED -> RECONCILING -> CONFIRMED` (or terminal `FAILED`).
- **Crash Recovery & Nonce Protection**:
  - `PREPARING` records `sender_address` and `transaction_nonce` BEFORE transaction broadcast.
  - `SUBMITTED` records `transaction_hash` immediately upon broadcast return before waiting for mining receipt.
  - On restart recovery, unmined jobs inspect onchain nonce counts (`latest` and `pending`) to prevent duplicate transactions or nonce reuse.
  - If a transaction was mined or settled by another actor, reconciliation rereads authoritative onchain state without resending.

---

## 2. Systemd Service Deployment (Bare Metal / Host Execution)

When running directly on the compute host (recommended for direct GPU access):

Create `/etc/systemd/system/archcore-agent.service`:

```ini
[Unit]
Description=ARCHcore Provider Agent
After=network.target

[Service]
Type=simple
User=archcore
Group=archcore
WorkingDirectory=/opt/archcore/apps/agent
EnvironmentFile=/etc/archcore/agent.env

# Manage persistent state directory: automatically creates /var/lib/archcore with 0700 permissions
StateDirectory=archcore
StateDirectoryMode=0700

# Service lifecycle
Restart=on-failure
RestartSec=5s

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/archcore
PrivateTmp=true

ExecStart=/usr/bin/node dist/server.js

[Install]
WantedBy=multi-user.target
```

### Environment Configuration (`/etc/archcore/agent.env`)
```bash
NODE_ENV=production
AGENT_HOST=0.0.0.0
AGENT_PORT=4002
CHAIN_ID=46630
RPC_URL=https://rpc.testnet.robinhood.com
RENTAL_MANAGER_ADDRESS=0x9b45526c710259d72777d8844953bb696e4b68df
COMPUTE_ASSET_ADDRESS=0xa87bc4d22a302c0dc082f0ed70bb530f3476b71f
USDG_ADDRESS=0x7E955252E15c84f5768B83c41a71F9eba181802F
NODE_ID=1
PROVIDER_PRIVATE_KEY=0x...

# Auto-settlement & Durable Journal Configuration
AGENT_AUTO_SETTLE=true
AGENT_SETTLEMENT_DB_PATH=/var/lib/archcore/settlement.sqlite
AGENT_SETTLE_CLAIM_LEASE_MS=60000
AGENT_SETTLE_BUSY_TIMEOUT_MS=5000
AGENT_SETTLE_RETRY_MAX_ATTEMPTS=5
AGENT_SETTLE_RETRY_DELAY_MS=5000

INFERENCE_BACKEND_MODE=demo
```

---

## 3. Docker Compose Deployment

When deploying via containerization, a persistent volume mount MUST be mapped to preserve `/var/lib/archcore` across container restarts, recreations, and updates.

### `docker-compose.yml`
```yaml
version: '3.8'

services:
  archcore-agent:
    image: archcore-agent:latest
    container_name: archcore-provider-agent
    restart: on-failure:5
    network_mode: "host" # or expose port 4002
    env_file:
      - /etc/archcore/agent.env
    environment:
      - AGENT_SETTLEMENT_DB_PATH=/var/lib/archcore/settlement.sqlite
    volumes:
      # Persistent host volume for SQLite database and WAL files
      - archcore-state:/var/lib/archcore
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]

volumes:
  archcore-state:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /var/lib/archcore
```

---

## 4. Single-Worker Instance Invariant

**CRITICAL**: Exactly ONE agent process must be actively configured as the settlement worker for a given provider node and private key.
- Running multiple concurrent agent processes with the same provider signer will cause nonce collisions and transaction contention onchain.
- The SQLite journal lease mechanism (`AGENT_SETTLE_CLAIM_LEASE_MS`) protects against concurrent processing if the SQLite file is shared, but independent unshared SQLite databases with the same signer will race onchain. Ensure single-instance deployment per node.

---

## 5. Backup & Maintenance

- **SQLite WAL Checkpointing**: The agent opens SQLite with WAL mode. Maintenance backups should use the SQLite online backup API or `sqlite3 /var/lib/archcore/settlement.sqlite ".backup '/backup/settlement.sqlite'"`.
- **Database Removal Warning**: Do NOT delete `/var/lib/archcore/settlement.sqlite` while a settlement is in progress (`PREPARING`, `SUBMITTED`, `MINED`, `RECONCILING`), as doing so destroys unbroadcast/pending nonce tracking and transaction hash memory required for idempotent crash recovery.
