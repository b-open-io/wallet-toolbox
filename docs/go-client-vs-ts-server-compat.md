# Go client → TS server compatibility

**Report scope**: Go `storage.WalletStorageProviderClient` ([client.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/client.go), [client_gen.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/client_gen.go)) calling canonical TS `StorageServer` ([StorageServer.ts](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/remoting/StorageServer.ts)).

---

## Q1: RPC surface coverage

TS `StorageServer` dispatches by method name via `this.storage[method](...params)` ([StorageServer.ts#L165](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/remoting/StorageServer.ts#L165)) — the effective surface is *every public method on `StorageProvider`*. The Go client ([client_gen.go#L118-L139](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/client_gen.go#L118-L139)) exposes 19 methods. Go method names are lowercased-first-char ([client_options.go#L23](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/client_options.go#L23)) — matches TS `StorageProvider` method names.

| Go client method | TS StorageProvider method | Status |
|---|---|---|
| `migrate` | [StorageIdb.migrate](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L83) / [StorageKnex.migrate](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageKnex.ts#L844) | OK |
| `makeAvailable` | [StorageReader.makeAvailable](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageReader.ts#L50) | OK |
| `setActive` | [StorageReaderWriter.setActive](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageReaderWriter.ts#L96) | OK |
| `findOrInsertUser` | [StorageReaderWriter.findOrInsertUser](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageReaderWriter.ts#L142) | OK |
| `internalizeAction` | [StorageProvider.internalizeAction](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageProvider.ts#L260) | OK |
| `createAction` | [StorageProvider.createAction](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageProvider.ts#L476) | OK |
| `processAction` | [StorageProvider.processAction](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageProvider.ts#L480) | OK |
| `insertCertificateAuth` | [StorageIdb.insertCertificateAuth](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L503) | OK |
| `relinquishCertificate` | [StorageProvider.relinquishCertificate](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageProvider.ts#L601) | OK |
| `relinquishOutput` | [StorageProvider.relinquishOutput](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageProvider.ts#L617) | OK |
| `listCertificates` | [StorageProvider.listCertificates](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageProvider.ts#L493) | OK |
| `listOutputs` | [StorageIdb.listOutputs](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L471) | OK |
| `listActions` | [StorageIdb.listActions](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L466) | OK |
| `getSyncChunk` | [StorageReader.getSyncChunk](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageReader.ts#L103) | OK |
| `findOrInsertSyncStateAuth` | [StorageReaderWriter.findOrInsertSyncStateAuth](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageReaderWriter.ts#L346) | OK |
| `processSyncChunk` | [StorageProvider.processSyncChunk](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageProvider.ts#L624) | OK |
| `abortAction` | [StorageProvider.abortAction](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageProvider.ts#L210) | OK |
| `findOutputBasketsAuth` | [StorageProvider.findOutputBasketsAuth](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageProvider.ts#L192) | OK |
| `findOutputsAuth` | [StorageIdb.findOutputsAuth](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L497) | OK |
| `listTransactions` | not found on StorageProvider chain | **Breaking** |

**R1 (Breaking)**: Go sends `listTransactions`; TS `StorageProvider` does not expose that method. TS `WalletStorageManager` has a `listActions`-backed flow. Server will respond `-32601 Method not found`. Go client has `ListTransactions` in [client_gen.go#L114-L116](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/client_gen.go#L114-L116).

**R2 (Cosmetic)**: TS `StorageClient` dispatches `findOutputBasketsAuth` under the RPC name `findOutputBaskets` ([StorageClient.ts#L391](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/remoting/StorageClient.ts#L391)). Go client sends `findOutputBasketsAuth` — `StorageProvider` does expose the `Auth` variant ([StorageProvider.ts#L192](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageProvider.ts#L192)), so Go's naming actually works.

---

## Q2: Sync protocol — Go-as-writer path

Go calls `reader.GetSyncChunk(args)` then `writer.ProcessSyncChunk(args, chunk)` locally ([sync_to_writer.go#L95-L102](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/sync_to_writer.go#L95-L102)).

| Concern | Finding | Severity |
|---|---|---|
| Offset order mismatch | **HARD BREAK**: Go sends offsets in [AllEntityNames order](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/wdk/entity_name.go#L23-L36) `provenTx, outputBasket, transaction, provenTxReq, txLabel, txLabelMap, output, outputTag, outputTagMap, cert, certField, commission`. TS chunker ordered `provenTx, outputBasket, outputTag, txLabel, transaction, output, txLabelMap, outputTagMap, cert, certField, commission, provenTxReq` ([getSyncChunk.ts#L39-L227](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/methods/getSyncChunk.ts#L39)). On the **third** offset (Go=`transaction`, TS expects `outputTag`), TS throws `WERR_INVALID_PARAMETER` at [getSyncChunk.ts#L236-L237](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/methods/getSyncChunk.ts#L236). Go's buildOffsets at [sync_to_writer.go#L119-L132](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/sync_to_writer.go#L119) iterates `AllEntityNames` unconditionally. | **Breaking** |
| Missing entity handling | Go ChunkProcessor has no branches for certificate/certificateField/commission ([chunk_processor.go#L90-L142](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L90)). TS reader returns those arrays populated. Go will **silently drop** them. | **Degraded** |
| Entity id translation for `transaction.provenTxId` | TS returns numeric `provenTxId` from its `provenTxs` table pk. Go has no `ProvenTx` idMap entry ([chunk_processor.go upsertProvenTx](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L264-L289) calls `updateSyncState` with no idDictionary). Data lands in KnownTx via `numeric_id_lookup` indirection but cross-storage id identity is not preserved. | **Degraded** |
| Empty-array "done" semantics | Go expects **all 12 slices present** per [storage_request_sync_chunk_args.go#L50-L51](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/wdk/storage_request_sync_chunk_args.go#L50-L51) ("infinite-loop if at least one entity is undefined"). TS reader returns `undefined` for entities it didn't touch this chunk. JSON `undefined` → field missing on wire → Go unmarshals to nil slice. Go's loop-exit relies on 2-consecutive-empty-chunks backstop ([sync_to_writer.go#L149-L157](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/sync_to_writer.go#L149)). | **Degraded** |

---

## Q3: Auth, serialization, errors

| Concern | Finding | Severity |
|---|---|---|
| BRC-103/104 auth | Go uses [go-sdk auth/clients/authhttp](/Users/davidcase/Source/1sat/go-sdk/auth/clients/authhttp/authhttp.go); TS server uses `@bsv/auth-express-middleware` ([StorageServer.ts#L125-L128](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/remoting/StorageServer.ts#L125)). Both implement BRC-103 (`x-bsv-auth-*` headers). | OK |
| AuthID shape | TS `{identityKey, userId?, isActive?}` ([WalletStorage.interfaces.ts#L179-L183](/Users/davidcase/Source/1sat/wallet-toolbox/src/sdk/WalletStorage.interfaces.ts#L179)) vs Go `{identityKey, userId?, isActive?}` ([auth_id.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/wdk/auth_id.go)). Match. | OK |
| JSON-RPC request shape | Filecoin go-jsonrpc sends `{jsonrpc:"2.0", method, params: [...], id}` positional array — matches TS `req.body` expectation with `params[0]`, `params[1]` indexing ([StorageServer.ts#L140](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/remoting/StorageServer.ts#L140)). | OK |
| Error response shape | TS returns `{jsonrpc, error: {isError, name, message}, id}` at HTTP 200 ([StorageServer.ts#L272-L277](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/remoting/StorageServer.ts#L272)). Filecoin expects `{code:int, message, data?, meta?}`. `name` field is silently dropped. `WERR_*` class is lost; users get the message string. | **Degraded** (error class invisible to Go callers) |
| Date serialization | Both sides use RFC3339/ISO 8601 via JSON string. `time.Time` ↔ `Date`. No known drift. | OK |
| Numeric precision | Go uses `uint64` for satoshis; TS uses `number` (54-bit safe). Values within safe int range round-trip. | Cosmetic |
| `processSyncChunk` param binding | TS server mutates `params[0].reqAuthUserId = user.userId`. Go's `RequestSyncChunkArgs` has `IdentityKey` field; server injects `userId` server-side. | OK |

---

## Q4: Is Go-client → TS-server a real deployment path?

**No**. All five concrete usages of `storage.NewClient` in the Go tree point at a Go `storage.NewServer`:

| Usage site | Target |
|---|---|
| [fixture_storage.go#L153](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/testabilities/fixture_storage.go#L153) | `s.testServer` = `httptest.NewServer(storageServer.Handler())` |
| [certifier/server.go#L160](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/certifier/server.go#L160) | Go storage server |
| [examples/internal/example_setup/setup.go#L119](/Users/davidcase/Source/1sat/go-wallet-toolbox/examples/internal/example_setup/setup.go#L119) | Go storage server |
| [examples/.../setup.go#L80](/Users/davidcase/Source/1sat/go-wallet-toolbox/examples/complex_wallet_examples/certifier_server_example/internal/example_setup/setup.go#L80) | Go storage server |
| [docs/storage_server.md#L48](/Users/davidcase/Source/1sat/go-wallet-toolbox/docs/storage_server.md#L48) | Doc example, generic |

No grep hits for `wallet-toolbox`/`StorageServer` TS references in the Go repo. The Go client is effectively a test harness for the Go server and a reference for future Go-native deployments. It has never been exercised against the TS `StorageServer`.

---

## Summary

| # | Severity | Finding |
|---|---|---|
| R1 | **Breaking** | Go `listTransactions` call has no TS `StorageProvider` method |
| S1 | **Breaking** | Go sends sync offsets in wrong order — TS `getSyncChunk` throws WERR_INVALID_PARAMETER on the 3rd offset |
| S2 | Degraded | Go `ProcessSyncChunk` silently drops certificate/certificateField/commission entities from TS chunks |
| S3 | Degraded | Go lacks `syncMap.provenTx.idMap`; cross-storage numeric id identity not preserved |
| S4 | Degraded | TS returns `undefined` entity arrays; Go tolerates only via a "2 empty chunks" backstop |
| E1 | Degraded | TS error shape `{isError, name, message}` vs filecoin go-jsonrpc `{code, message, data}`. `WERR_*` class name lost |
| R2 | Cosmetic | TS's own `StorageClient` uses RPC name `findOutputBaskets`; Go uses `findOutputBasketsAuth`. Both work |

**Verdict**: Go client → TS server is **not recommended** — sync breaks at the first offset-order check, `listTransactions` returns method-not-found, and cert/commission data is silently dropped.
