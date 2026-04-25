# arti-client Port — Plan for Next Session

**Goal:** make Tor work on Android so the linked-device-by-QR flow becomes useful — both devices can actually send/receive messages.

**Status before this session:** on Android, `start_tor()` returns a `Disabled { reason: "Tor on mobile not yet implemented" }` stub. The UI works, account creation works, QR linking works, but no network I/O happens because there's no onion service and no SOCKS proxy to relay outbound traffic through.

## What this session shipped (refactor only — no arti deps yet)

Pulled the trait scaffolding out so the actual arti integration is a drop-in next time:

- `tor.rs` now defines `TorTransport` (with `dial`, `take_listener`, `onion_address`, `shutdown`), plus `TorStream` / `BoxedStream` / `TorListener` helpers.
- The existing tor.exe + SOCKS5 + loopback-listener code lives in a `SubprocessTor` impl behind `#[cfg(desktop)]`. Behavior on desktop is unchanged.
- `ArtiTor` exists behind `#[cfg(mobile)]` as a stub that emits `Disabled` — same UX as before on Android, but now wired through the trait.
- `tor_net.rs` is now transport-agnostic: it takes an `Arc<dyn TorTransport>`, calls `transport.dial(...)` instead of `Socks5Stream::connect`, and reads from `transport.take_listener()` instead of binding `127.0.0.1:HIDDEN_SERVICE_TARGET_PORT` directly.
- `AppState.tor` is now `RwLock<Option<Arc<dyn TorTransport>>>`. `build_session` clones the Arc into the new `tor_net` task.
- Added `async-trait = "0.1"` to Cargo.toml. **Did NOT add arti-client / tor-hsservice yet** — kept that for the next session so we don't pay the 8-min cold compile cost without actually using it.

Verified `cargo check` and `cargo test` both pass on desktop (16 unit tests green).

**Remaining for next session:** add the arti deps, replace the `ArtiTor` stub with a real implementation (Sections 1, 3, 5 below). Sections 2 and 4 are done.

## Second session — ArtiTor impl written, but blocked on a rusqlite version conflict

Written but not yet merged into a working build:

- `ArtiTor` real impl in `src/tor.rs` (under `#[cfg(target_os = "android")]`): bootstraps `TorClient` in a background task, launches an onion service via `tor_hsservice::config::OnionServiceConfigBuilder`, runs an accept loop that translates `RendRequest` → `StreamRequest::accept(Connected::new_empty())` → `DataStream`, exposes `dial` via `TorClient::connect((onion, port))`. Handles slot management (client/service/listener slots filled by the bg task) so the trait's `&self`-only methods can be sync where required (`onion_address`).
- `commands.rs::start_tor` updated with three branches: desktop → SubprocessTor; android → ArtiTor; mobile-non-android (iOS) → emit Disabled. Imports gated to `#[cfg(target_os = "android")]`.

**What blocked the build initially:**

`arti-client 0.41 → tor-dirmgr 0.41` requires `rusqlite >=0.36, <0.39`. We pinned `rusqlite = "0.32"`. Both crates declare `links = "sqlite3"`, and Cargo's links rule forbids two packages from claiming the same native library — even when target-gated, since Cargo's links check runs per-target and on the android target both pin levels coexist.

## Third session — rusqlite bump + arti deps merged, verification gap on android

Resolved the rusqlite blocker and re-added arti to Cargo.toml:

1. **rusqlite 0.32 → 0.38**, **r2d2_sqlite 0.25 → 0.32** (the highest pair compatible with arti 0.41's `tor-dirmgr` requirement of `rusqlite >=0.36, <0.39`). Surprisingly, no source changes needed in `storage.rs` or `identity.rs` — the rusqlite API surface we use (`params!`, `execute_batch`, `query_row`, `prepare`, pool conn) was stable across the bump. `cargo test` still 16/16 green on desktop.
2. Re-added arti deps under `[target.'cfg(target_os = "android")'.dependencies]` (arti-client + tor-hsservice + tor-rtcompat + tor-cell, all pinned to 0.41). Desktop `cargo check` still passes — Cargo correctly skips android-target deps for desktop compilation.

**What's still unverified:**

The ArtiTor code itself has not been compile-checked yet. `cargo check --target aarch64-linux-android` was attempted but failed in the build script of `ring` (a transitive crypto dep of arti's rustls):

```
warning: ring@0.17.14: Compiler family detection failed due to error:
  ToolNotFound: failed to find tool "aarch64-linux-android-clang": program not found
error occurred in cc-rs: failed to find tool "clang.exe": program not found
```

This is environmental — the build machine has no Android NDK installed. We need the NDK's `clang` on PATH (or pointed at via `CC_aarch64_linux_android` env var) before `ring` will build.

**Setup needed before next android cargo check:**

1. Install Android NDK r25+ (via Android Studio's SDK Manager or standalone NDK download).
2. Either add `<NDK>/toolchains/llvm/prebuilt/windows-x86_64/bin` to PATH, or set:
   ```
   set CC_aarch64_linux_android=<NDK>/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android21-clang.cmd
   set CC_armv7_linux_androideabi=<NDK>/toolchains/llvm/prebuilt/windows-x86_64/bin/armv7a-linux-androideabi21-clang.cmd
   set CC_x86_64_linux_android=<NDK>/toolchains/llvm/prebuilt/windows-x86_64/bin/x86_64-linux-android21-clang.cmd
   set CC_i686_linux_android=<NDK>/toolchains/llvm/prebuilt/windows-x86_64/bin/i686-linux-android21-clang.cmd
   ```
   (Adjust API level 21 to taste.)
3. Re-run `cargo check --target aarch64-linux-android`. First check WILL be slow (~8 min, ~120 crates).
4. If `ArtiTor` compiles cleanly: try `npm run tauri android dev` for a real device test.

## Fourth session — code-review fixes against arti 0.41 source

Without an NDK to actually compile-test ArtiTor on android, I went back to arti's source on gitlab.torproject.org and re-validated each API call against the real 0.41 code. Two real bugs found and fixed:

1. **`launch_onion_service` return type**: the `arti-axum` example I wrote against destructures the result as `(svc, requests)`, but the actual 0.41 signature is `Result<Option<(Arc<RunningOnionService>, impl Stream<Item = RendRequest>)>, Error>` — the Option wraps the tuple (None when service is config-disabled). Fixed by adding `.ok_or_else(...)?` after the existing `?`. The arti-axum example is either broken against current 0.41 or its readme is stale.

2. **`OnionServiceConfigBuilder.nickname()` type inference**: my `"shroud".to_owned().try_into()` relied on inference from the `.nickname(nickname)` call site. arti has multiple `TryFrom<String>` impls in scope (HsNickname, HsId, others), so inference can fail. Pinned the type explicitly: `let nickname: tor_hsservice::HsNickname = ...`.

3. **fs-mistrust on Android (proactive)**: arti's `from_directories` config sets up a default `Mistrust` that on android would reject our state_dir because the per-user/per-group trust APIs are explicitly unavailable on android. Added `builder.storage().permissions().dangerously_trust_everyone()` to skip the check. This isn't actually loosening security — Android already sandboxes our state_dir to the app's UID, so the check would just be redundant friction.

Verified each API name against arti gitlab source:
- `tor_hsservice::config::OnionServiceConfigBuilder` — confirmed, `pub mod config` exports it.
- `tor_hsservice::HsNickname` — confirmed, re-exported from root.
- `tor_hsservice::handle_rend_requests` — confirmed.
- `tor_hsservice::RunningOnionService` — confirmed (defined in lib.rs root).
- `tor_cell::relaycell::msg::Connected::new_empty()` — confirmed earlier.
- `arti_client::config::TorClientConfigBuilder::from_directories(state, cache)` — confirmed.
- `MistrustBuilder::dangerously_trust_everyone(&mut self) -> &mut Self` — confirmed available on android.
- `(&str, u16): IntoTorAddr` — confirmed in arti's `address.rs`.

Desktop `cargo check` still passes after all the fixes. The remaining unknown is whether the bg-task future is `Send` on android — `tokio::spawn` requires it, and we hold an `impl Stream<Item = StreamRequest>` across `.await` points. The stream's Send-ness depends on arti's internals; if it isn't Send we'd see a clear compiler error and switch to `tokio::task::spawn_local` + a `LocalSet`.

**API references used to write `ArtiTor` (current as of arti 0.41):**

- `TorClient::create_bootstrapped(TorClientConfig).await -> Result<TorClient<PreferredRuntime>>`
- `TorClientConfigBuilder::from_directories(state_dir, cache_dir).build()` — sidesteps arti's $HOME-based default discovery.
- `client.launch_onion_service(OnionServiceConfig) -> Result<(Arc<RunningOnionService>, impl Stream<Item = RendRequest>)>` — note: per the working `arti-axum` example, NOT `Result<Option<...>>` as docs.rs suggested. Trust the example.
- `OnionServiceConfigBuilder::default().nickname("shroud".to_owned().try_into().unwrap()).build()` — nickname is String → HsNickname via TryInto.
- `handle_rend_requests(rend_requests) -> impl Stream<Item = StreamRequest>` (re-exported from `tor_hsservice`).
- `StreamRequest::accept(Connected::new_empty()).await -> Result<DataStream>` — Connected lives in `tor_cell::relaycell::msg`, hence the `tor-cell` dep.
- `RunningOnionService::onion_address() -> Option<HsId>` — may return None until descriptor publishes; we poll for ~60s.

**Fs-mistrust on Android:** arti normally enforces strict Unix file permissions on its state dir via fs-mistrust. Android's app-private storage doesn't follow the model arti expects. We didn't wire this in yet — `from_directories` defaults may complain. If `cargo check --target aarch64-linux-android` succeeds but bootstrap fails at runtime with a permission error, set `ARTI_FS_DISABLE_PERMISSION_CHECKS=true` env var at process start, or override via `TorClientConfigBuilder`'s storage().permissions().dangerously_trust_everyone() if that API exists in 0.41.

## Why arti (and not bundling tor.exe for Android)

Three rejected alternatives:
- **Bundle an Android `tor` binary** from torproject.org. Fragile — we'd need to ship four native libraries (arm64, armv7, x86_64, x86), manage the subprocess lifecycle against Android's process-kill policies, and users would see "Shroud is using battery" notifications from our tor child.
- **Use Orbot** as a SOCKS proxy. Requires user to install a second app. Non-starter for "just install and talk."
- **Wait for official Tauri Tor plugin**. Doesn't exist, no signal it will.

arti is pure-Rust, compiles with our existing toolchain, runs in-process, supports v3 hidden services as of late 2024.

## Approach: introduce a `TorTransport` trait

Create a small interface in `tor.rs`:

```rust
#[async_trait::async_trait]
pub trait TorTransport: Send + Sync {
    /// Launch the transport. Returns a handle plus an event stream for
    /// the UI (bootstrap progress → ready → onion address).
    async fn spawn(data_dir: PathBuf) -> AppResult<(Box<dyn TorTransport>, mpsc::Receiver<TorEvent>)>
    where Self: Sized;

    /// Open a TCP-like stream to `<onion>:<port>`.
    async fn dial(&self, onion: &str, port: u16) -> AppResult<BoxedStream>;

    /// Stream of incoming connections accepted on our hidden service.
    /// Ownership transfers on first call.
    async fn take_listener(&self) -> AppResult<BoxedListener>;

    /// Current onion address of our hidden service, once ready.
    fn onion_address(&self) -> Option<String>;

    /// Synchronous shutdown (called on app exit).
    async fn shutdown(&mut self);
}
```

Two implementations:

1. **`SubprocessTor`** (current code refactored) — spawns `tor.exe`, uses SOCKS5 for outbound, listens on a local port that Tor forwards from `.onion`. Desktop-only.

2. **`ArtiTor`** (new) — holds an `arti_client::TorClient` plus a `tor_hsservice::OnionService`. Mobile-only by default, but could replace subprocess on desktop later if reliable.

`AppState::tor` stores a `Box<dyn TorTransport>`. Compile-time cfg chooses which to spawn:

```rust
#[cfg(desktop)]
let (transport, rx) = SubprocessTor::spawn(data_dir).await?;
#[cfg(mobile)]
let (transport, rx) = ArtiTor::spawn(data_dir).await?;
```

## Concrete work items

### 1. Cargo deps (~30 min + ~15 min first compile)

Target-gated so desktop doesn't pay the arti compile cost unless we later decide to share:

```toml
[target.'cfg(target_os = "android")'.dependencies]
arti-client = { version = "0.41", default-features = false, features = [
  "tokio",
  "rustls",
  "onion-service-service",
  "onion-service-client",
] }
tor-hsservice = "0.41"
tor-hscrypto = "0.41"
tor-rtcompat = { version = "0.41", features = ["tokio", "rustls"] }
fs-mistrust = "0.10"
```

Sanity-check: first `cargo check --target aarch64-linux-android` brings in ~120 extra crates, ~8 minutes cold compile. Re-checks are seconds.

### 2. Refactor existing `tor.rs` (~2-3 hours)

- Extract `SubprocessTor` impl block from current `TorManager`.
- Move the `torrc` generation, PID-file stale-tor cleanup, stdout progress parsing, hidden-service key loading into methods on `SubprocessTor`.
- `TorManager` → alias for `Box<dyn TorTransport>` (or just rename).

### 3. Implement `ArtiTor` (~2 hours)

Roughly:

```rust
pub struct ArtiTor {
    client: Arc<TorClient<PreferredRuntime>>,
    onion_service: OnionService,
    listener_rx: Option<mpsc::Receiver<RendRequest>>,
}

impl ArtiTor {
    async fn spawn(data_dir: PathBuf) -> ... {
        let (tx, rx) = mpsc::channel(16);
        let config = TorClientConfig::builder()
            .storage(data_dir.join("arti"))
            .build()?;

        let client = TorClient::create_bootstrapped(config).await?;
        // emit Ready on tx

        let hs_config = OnionServiceConfig::builder()
            .nickname("shroud")
            .build()?;
        let (svc, req_stream) = client.launch_onion_service(hs_config)?;
        let onion_addr = svc.onion_name().to_string();
        // emit OnionReady { address } on tx

        Ok((Box::new(ArtiTor { ... }), rx))
    }
}

#[async_trait]
impl TorTransport for ArtiTor {
    async fn dial(&self, onion: &str, port: u16) -> AppResult<BoxedStream> {
        let stream = self.client.connect((onion, port)).await?;
        Ok(Box::new(stream))
    }

    async fn take_listener(&self) -> AppResult<BoxedListener> {
        // req_stream → stream of incoming rendezvous requests;
        // each requires `.accept().await?` to get a DataStream.
    }
}
```

Gotchas to anticipate:
- arti's `RendRequest` needs `.accept()` with a `StreamRules` config. Copy from arti's examples.
- Key storage: arti uses its own directory layout for onion-service keys. On first run it generates a new keypair → a DIFFERENT `.onion` than what we had via subprocess. Document that migration from subprocess → arti changes your address (acceptable for mobile since there's nothing to migrate).

### 4. Rewire `tor_net.rs` (~2 hours)

Currently tor_net connects via `tokio_socks::tcp::Socks5Stream::connect(("127.0.0.1", SOCKS_PORT), (onion, port))`. Replace with:

```rust
let stream = transport.dial(&onion, port).await?;
```

`BoxedStream` must implement `AsyncRead + AsyncWrite + Unpin`. Both arti's `DataStream` and our subprocess `Socks5Stream` do, so it's a type-erase and go.

Same change for the listener side.

### 5. End-to-end test (~1 hour)

- Build desktop 0.1.2 with the refactored `SubprocessTor` — regress-test that everything still works.
- Build Android 0.1.2 with `ArtiTor` — install on phone, create account or link via QR.
- Send message: PC → phone → should arrive.
- Send message: phone → PC → should arrive.
- Confirm `.onion` stays the same across app restarts (arti persists keys).

## Known risks

1. **Compile time**: arti brings in 120+ crates. First build of APK after adding arti might be 15+ minutes. Subsequent builds fine.

2. **APK size**: debug APK was 163 MB. With arti, expect another ~30 MB. Release builds strip debug info and compile with LTO, so release APK should come down to ~40-60 MB.

3. **Bootstrap time on mobile**: arti bootstrap on a mid-range Android over mobile data may take 20-60 seconds first launch (downloads consensus). Cached after that.

4. **iOS**: arti has known issues with iOS's background execution model. If/when we add iOS we'll need a different approach. Not blocking for Android.

## Out of scope (don't touch this session)

- Voice calls over arti — current voice-over-Tor code already goes through `tor_net` so it'll work automatically once `tor_net` is rewired.
- Multi-device device certificates / master key / fan-out — that's the bigger linked-devices v2 (see `docs/LINKED_DEVICES.md`). Current session's QR-link gives users the *same* identity on PC and phone, which is what they actually asked for.
- Release 0.1.2 — we'll build and ship it once the arti port is verified end-to-end.
