# Watchwise local Store edition

This v0.4.0 edition is a separate, local-only Chrome Web Store payload. It uses the `watchwise-local` IndexedDB database and never reads the full development edition’s storage.

All persisted events, settings, onboarding state and intervention state are AES-256-GCM encrypted before storage. A non-extractable key is stored in a separate IndexedDB key store in the same Chrome profile. Export is an explicit user action and produces plaintext JSON, which the user must store safely.

Chrome assigns an unpacked extension and a Store-installed extension different IDs and storage silos. A first Store install therefore starts with empty history and cannot import history from the unpacked v0.3.9 build. Exported JSON is a human-readable backup only; this edition does not provide JSON import.

The public package is generated from the edition overlay plus reviewed shared tracking modules. Do not upload the `store-local` source directory directly; use `scripts/package_local_store.rb`.
