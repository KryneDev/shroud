# Linked Devices Protocol — Design Doc

**Status:** Draft. Implementation starts after sign-off.

## Goal

One Shroud account usable on multiple devices (PC + phone) with:
- **Shared identity** — same `.onion` address on every device
- **Message fan-out** — a message sent to the account reaches every linked device
- **History sync** — joining a new device gives it the existing chat history
- **Revocation** — a lost phone can be removed remotely

Non-goals (for v1):
- Real-time typing / read-receipt sync across devices (deferred)
- Group-device-voting (device compromise scenarios)

## Threat model

- Attacker can intercept any Tor traffic (they can't decrypt it, but they see it exists).
- Attacker can steal one device (laptop), but not both simultaneously.
- Attacker does NOT have the user's master password.
- An attacker with root on a device already reads everything; we can't defend against that.

The design must ensure:
1. A linked device has its OWN sub-key, signed by the master. Compromising a phone doesn't leak the master.
2. Revoking a device invalidates its sub-key so its signatures stop being accepted.
3. The linking handshake uses a short-lived out-of-band token (QR code) that an attacker watching Tor cannot replay.

## Key hierarchy

```
Master Ed25519 keypair         ← identity; the one that decides who you are
  ├── Device Ed25519 keypair   ← per-device, signed by master
  │     (signs envelopes this device sends)
  └── Device Ed25519 keypair   ← another device
        (signed by master)
```

- **Master key** stays on the primary device. Only re-exported when linking a new device.
- **Device keys** are generated locally on each device. Only the pubkey travels; the priv never leaves.
- The master signs a **device certificate**: `sign_master({ device_pubkey, device_name, created_at })`.
- When a contact receives an envelope, they check:
  1. Envelope signature was made by `sender_device_pubkey`.
  2. The envelope carries a device certificate valid for `sender_device_pubkey`, signed by the known master pubkey.
  3. TOFU match: `master pubkey` equals the one pinned for this contact (existing check, just moved one level up).

This replaces the current "TOFU on sender_pubkey directly" model. Contacts pin the **master** pubkey; devices come and go.

## Linking flow

### Primary side (PC)

Open Settings → **Linked devices** → **Link a new device**.

The primary generates:
- `link_token`: 32 random bytes, valid for 5 minutes
- QR content (JSON, base64):
  ```json
  {
    "v": 1,
    "onion": "<56-char-onion>",
    "master_pub": "<ed25519 pubkey base64>",
    "link_token": "<32B base64>"
  }
  ```

While the QR is shown, the primary's `tor_net` accepts one extra request type: `LinkRequest`.

### Secondary side (phone)

Scan QR → parse JSON. Phone has no identity yet.

Secondary generates its own device keypair locally: `device_pub`, `device_priv`.

Secondary opens a Tor connection to `onion` and sends a signed **LinkRequest**:

```
LinkRequest {
  link_token: [u8; 32],      // from QR
  device_pub: [u8; 32],      // phone's new key
  device_name: String,       // e.g. "Alice's Pixel 8"
  proof: signature,          // sign(device_priv, SHA256(link_token || device_pub))
}
```

### Primary approves

Primary shows a prompt: **"Link device 'Alice's Pixel 8'? Fingerprint: 4F-E2-88-..."** (first 4 bytes of `device_pub` in hex).

On user approve, primary:
1. Issues a device certificate:
   ```
   DeviceCert {
     device_pub: [u8; 32],
     device_name: String,
     created_at: i64,
     signature: sign(master_priv, CBOR({ device_pub, device_name, created_at })),
   }
   ```
2. Builds an encrypted snapshot of account state:
   ```
   AccountSnapshot {
     master_priv: [u8; 32],       // encrypted — phone needs it to accept future linking invitations
     contacts: Vec<Contact>,
     messages: Vec<StoredMessage>,
     // other state: nickname, reactions, groups, etc.
   }
   ```
   - Encrypted with key derived from `HKDF(SHA256, link_token, info="shroud-linking")`.
   - The token is never used again, so the key is one-time.
3. Sends `LinkApproved { cert: DeviceCert, encrypted_snapshot: Vec<u8> }` back over the same Tor stream.
4. Stores the new device in local `linked_devices` table.

Primary invalidates `link_token` after one use.

### Secondary finalizes

Phone:
1. Verifies `cert.signature` against `master_pub` from QR.
2. Decrypts snapshot with HKDF(link_token).
3. Saves everything to its local DB.
4. From now on signs envelopes with its OWN `device_priv` and attaches its cert.

## Message fan-out

When Alice (sender) sends a message to Bob:

1. Alice's active device signs the envelope normally (envelope contains device cert).
2. Tor routes to Bob's `.onion` → Bob's **primary** device receives (first-to-answer).

**Primary fan-out**: Primary device, after accepting the inbound envelope, re-wraps it for each of its linked devices and delivers over their private Tor connections.

### The "primary" role

One of Bob's linked devices is designated primary — it hosts the Tor hidden service. When primary is offline, incoming messages queue at the sender's retry buffer (already in our design).

Over time we can add "hot failover": multiple devices publish onion descriptors with different intro points, so any online device receives. For v1 we keep "primary = PC". Phone links to primary over Tor when awake and pulls missed messages.

## Sync protocol (phone wakes up)

When phone wakes up (app foregrounded), it connects to its primary (known onion) and:

```
SyncRequest {
  last_seen_seq: u64,
  device_cert: DeviceCert,
  signature: sign(device_priv, ...),
}
```

Primary responds with all envelopes with `seq > last_seen_seq` for this account, fan-out queue catch-up included.

This requires primary to persist a per-device `last_seen_seq`. That's a new column on `linked_devices`.

## Device revocation

Settings → Linked devices → (pencil) → **Revoke**.

This:
1. Moves the device row to a `revoked_devices` table (keeping cert for history).
2. Updates a local revocation list.
3. Next incoming envelope from that `device_pub` is rejected by any device that has the revocation list.

Contacts don't need to know about revocation — the master still accepts their messages; only the revoked device can no longer **send** as us.

## Storage changes

### New tables
```sql
CREATE TABLE linked_devices (
  device_pub  BLOB PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen_seq INTEGER DEFAULT 0
);

CREATE TABLE revoked_devices (
  device_pub  BLOB PRIMARY KEY,
  revoked_at  INTEGER NOT NULL
);
```

### Changed
- `messages`: add `device_pub` column — which device sent this (used for self-filtering so you don't duplicate messages you sent from another device).
- `contacts`: `pinned_pubkey` semantic changes from "first sender_pubkey" to "master pubkey from first device cert seen". Needs a migration for existing installs — map pinned to master on first message post-upgrade.

## Migration concerns

Existing installations (v0.1.x) have a single-key identity. On first launch of the multi-device version:

1. Treat the current key as both master AND primary device key.
2. Issue a self-signed device cert with `device_pub == master_pub`.
3. Existing envelopes continue to verify (device cert signed by master, where master == device).

For contact pinning: the next envelope from an existing contact will carry a cert with `device_pub == their master_pub`; storage just updates the pinned pubkey to master (no behavior change since they're the same).

## UI

### PC — new Settings section

**Linked Devices**
- List of currently linked devices (name, last seen, revoke button)
- Button: **"Link new device"** → modal with QR + "waiting..." spinner
- On success: "Device 'Alice's Pixel 8' linked!"

### Android — first launch

1. Screen: "Create new identity" | "Link to existing device"
2. If Link → QR scanner opens → scan → approval flow on primary → done.

## Open questions

1. **Group chats**: each group member has a `master_pub`. Do we add `device_pub` to group envelopes? For v1, we use device cert inside envelope; group semantic unchanged.
2. **Call routing**: if Alice calls Bob and both of Bob's devices are online, only one should ring. Primary answers, others get notified the call was taken. Deferred.
3. **Snapshot size**: if a user has 500 MB of cached attachments, the link snapshot is huge over Tor. We can opt-out of attachments in initial snapshot and re-fetch on demand.

## Timeline

| Step | Work | Effort |
|------|------|--------|
| 1 | DB migration + linked_devices table | 0.5 day |
| 2 | Master/device keypair split + cert system | 1 day |
| 3 | Envelope format v2 with device cert | 0.5 day |
| 4 | LinkRequest / LinkApproved protocol | 1 day |
| 5 | Fan-out + sync on inbound | 0.5 day |
| 6 | PC Settings UI for linked devices + QR gen | 0.5 day |
| 7 | Android QR scanner + linking UI | 1 day |
| 8 | End-to-end test PC ↔ PC (same machine, different data-dirs) | 0.5 day |
| 9 | Android port (tor via arti, etc.) | 2-3 days |

**~7-9 days total.** PC-side alone is ~4 days.
