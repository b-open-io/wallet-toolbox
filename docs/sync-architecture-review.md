---

# wallet-toolbox sync architecture review

Canonical: `/Users/davidcase/Source/1sat/wallet-toolbox`
Go port: `/Users/davidcase/Source/1sat/go-wallet-toolbox`

---

## Section 1: Sync architecture (canonical TS)

### 1.1 Entry points: `syncToWriter`, `updateBackups`, `setActive`

All cross-store replication flows through [WalletStorageManager](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts).

- [WalletStorageManager.syncToWriter](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L675-L714) pushes data **from the manager's current active** (acting as reader) **to an arbitrary writer store**. It acquires the sync lock via [runAsSync](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L352-L363) and loops, constructing an [EntitySyncState](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L28) per iteration. For each iteration: build `RequestSyncChunkArgs`, call `reader.getSyncChunk(args)`, then `writer.processSyncChunk(args, chunk)`. Loop exits when the writer reports `done=true`.
- [WalletStorageManager.updateBackups](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L716-L727) iterates `_backups` and calls `syncToWriter` for each backup. The active is always the source.
- [WalletStorageManager.setActive](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L736-L826):
  - Verifies the target store is in `_stores`.
  - If there are conflicting actives ([_conflictingActives](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L73-L75)), merges each conflict's state into `newActive` using `syncToWriter` with the conflict store passed as `activeSync` (the reader override). Then it propagates from `backupSource=newActive` to all other stores.
  - If no conflicts, pushes from `_active` to all other stores.
  - Calls [storage.setActive(auth, storageIdentityKey)](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageReaderWriter.ts#L96-L100) on the `backupSource` to flip its user.activeStorage. This activeStorage gets replicated to the rest via `mergeUser` inside processSyncChunk.
  - Resets `_isAvailable` and re-runs `makeAvailable()`.
- [syncFromReader](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L632-L673) is the inverse: pulls from an arbitrary reader and writes into the manager's active. Critically, it **strips `chunk.user.activeStorage` before merging** — a pulled sync may not change which store is active ([line 660](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L660)).

### 1.2 SyncChunk contents

[SyncChunk](/Users/davidcase/Source/1sat/wallet-toolbox/src/sdk/WalletStorage.interfaces.ts) (imported by [EntitySyncState.syncChunkSummary](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L288-L321)) carries:
`user`, `provenTxs`, `outputBaskets`, `outputTags`, `txLabels`, `transactions`, `outputs`, `txLabelMaps`, `outputTagMaps`, `certificates`, `certificateFields`, `commissions`, `provenTxReqs` — twelve entity arrays plus an optional user row. Each array may be `undefined` (entity type skipped this chunk) or an array (possibly empty, means "no more rows after current offset").

[getSyncChunk](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/methods/getSyncChunk.ts) builds the chunk. It iterates [chunkers array](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/methods/getSyncChunk.ts#L39-L228) in order, using a per-call `itemCount` / `roughSize` budget, paging each entity with `since` and offset from `args.offsets`. The offset order must match chunker order or it throws [WERR_INVALID_PARAMETER](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/methods/getSyncChunk.ts#L236-L237).

### 1.3 EntitySyncState — the cursor

[EntitySyncState](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L28) wraps the `sync_states` table row. Key fields:
- [when](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L154-L159): the `since` timestamp; all rows with `updated_at >= when` are in scope for the next sync cycle.
- [syncMap](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L222): a stringified JSON blob containing one [EntitySyncMap](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityBase.ts#L89-L111) per entity type: `{entityName, idMap, maxUpdated_at?, count}`.

Created/looked up by [fromStorage](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L62-L78) via `findOrInsertSyncStateAuth` on the **writer** side, keyed by `(userId, storageIdentityKey=from, storageName)`. So the sync state is *per (writer, reader-identity-key) pair* and lives inside the writer.

[makeRequestSyncChunkArgs](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L253-L286) builds `RequestSyncChunkArgs` using `this.when` and `ess.count` for each of the twelve entities, pushed in **this order**: `provenTx, outputBasket, outputTag, txLabel, transaction, output, txLabelMap, outputTagMap, certificate, certificateField, commission, provenTxReq`.

[processSyncChunk](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L323-L388) is the heart of the merger:
- Builds twelve [MergeEntity](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/MergeEntity.ts#L11) wrappers in a specific order (see line 334-345) that matters for ID translation: `provenTx → outputBasket → outputTag → txLabel → transaction → output → txLabelMap → outputTagMap → certificate → certificateField → commission → provenTxReq`.
- Merges `chunk.user` first (but only via `mergeExisting` — [line 354-363](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L354-L363); a local user record is assumed to already exist via `findOrInsertUser` at manager init).
- Each `MergeEntity.merge` ([merge](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/MergeEntity.ts#L40-L72)) loops the stateArray: calls per-entity `mergeFind`, branches to `mergeExisting` (if found and incoming is newer) or `mergeNew`. Then appends `(eiId → eo.id)` to the entity's idMap via [updateSyncMap](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/MergeEntity.ts#L29-L35), which throws if a key already maps to a different target.
- After all entities, `me.esm.count += stateArray.length` (becomes the offset for the next chunk).
- `done = true` iff *every* entity's stateArray is defined AND length === 0 ([line 374](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L374)). On done, `this.when = maxUpdated_at` and all counts reset ([line 381-383](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L381-L383)). Finally [updateStorage](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L86-L97) persists the new syncMap+when on the writer.

"Resetting sync state" means: first chunk has `since=undefined` and all offsets=0; all idMaps start `{}`. The moment the writer receives a first chunk, the `sync_states` row is created and fed `when`/syncMap via updateStorage. If a sync is interrupted after idMaps are populated but before the terminal empty chunk arrives, the partially-populated syncMap is persisted with its counts. The next `fromStorage` call returns that same row, and offsets resume mid-stream. **Only** the terminal empty chunk advances `when` and resets counts to 0.

### 1.4 `syncMap.idMap` — the translation table

Every `idMap` is `Record<number, number>`: source-storage primary id → target-storage primary id. Populated in [MergeEntity.merge](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/MergeEntity.ts#L66) via `updateSyncMap(this.idMap, eiId, eo.id)`. It is consulted in every entity's `mergeNew`/`mergeExisting`/`mergeFind` to translate cross-referenced FKs. Examples:
- [EntityOutput.mergeFind](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityOutput.ts#L231-L251) translates `ei.transactionId` via `syncMap.transaction.idMap` before querying locally by `{userId, transactionId, vout}`.
- [EntityOutput.mergeNew](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityOutput.ts#L253-L260) translates `basketId`, `transactionId`, `spentBy`.
- [EntityTransaction.mergeNew](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityTransaction.ts#L256-L261) translates `provenTxId` via `syncMap.provenTx.idMap`.

Because idMaps are populated **as each entity type is processed within the same chunk**, the entity processing order in [processSyncChunk](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L334-L346) is load-bearing — parent entities must come before their children. Outputs always come *after* transactions within a single chunk. But across chunks: an output referencing a transactionId whose row was merged in a prior chunk will rely on that prior chunk's idMap entry having been persisted in the sync_states row (see failure mode in Section 3).

### 1.5 Per-entity merge logic

[MergeEntity.merge](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/MergeEntity.ts#L40-L72) is the generic driver. Per entity:

| Entity | mergeFind key | mergeNew | mergeExisting gate |
|---|---|---|---|
| user | identityKey (from auth, not from chunk) | n/a | `ei.updated_at > this.updated_at` — updates activeStorage only |
| provenTx | `txid` | insert new, keep ids mapped | LWW by updated_at |
| outputBasket | `{name, userId}` | insert, map ids | LWW |
| outputTag | `{tag, userId}` | insert, map ids | LWW |
| txLabel | `{label, userId}` | insert, map ids | LWW |
| **transaction** | [{reference, userId}](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityTransaction.ts#L243-L248) | insert, translate provenTxId, map ids | LWW |
| **output** | [{userId, transactionId, vout}](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityOutput.ts#L240-L245) — after translating transactionId via syncMap | insert, translate basketId/transactionId/spentBy | LWW |
| txLabelMap | (composite) | insert translated ids; no idMap entry (no primary id pair) | n/a |
| outputTagMap | (composite) | insert translated ids; no idMap entry | n/a |
| certificate | `{userId, type, serialNumber, certifier}` | insert, map ids | LWW |
| certificateField | `{certificateId, fieldName}` | insert translated certificateId; no idMap entry | LWW |
| commission | `{userId, transactionId}` | insert translated transactionId, map ids | LWW |
| provenTxReq | `txid` (unique) | insert, translate provenTxId, map ids | LWW |

### 1.6 `user.activeStorage` and isActiveEnabled

Each store holds its own `TableUser` row which includes an `activeStorage` string (see [EntityUser](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityUser.ts)). The value is the `storageIdentityKey` of the store the user last chose as active.

[WalletStorageManager.makeAvailable](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L141-L193) partitions stores:
- First pass: default-active is `_stores[0]`. If a later store has `user.activeStorage === itsOwnStorageIdentityKey`, it supersedes — becoming the active.
- Second pass: any store whose `user.activeStorage !== newActive.storageIdentityKey` goes into `_conflictingActives`; others into `_backups`.

[isActiveEnabled](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L115-L122) is TRUE iff the active's own user.activeStorage equals its own storageIdentityKey AND there are no conflicting actives. Mutations are blocked ([getAuth(mustBeActive=true)](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L203-L207) throws `WERR_NOT_ACTIVE`) when `isActive` is false.

---

## Section 2: Is the design truly "one-way"?

The design is **one-way per call, but bidirectional across two calls**. Both `syncToWriter` and `syncFromReader` exist. `syncToWriter` pushes from the manager's current *active* (reader) to a specified *writer*. `syncFromReader` pulls from a specified *reader* into the manager's current *active* (writer).

### 2.1 `syncToWriter` is always a PUSH from reader to writer

In [syncToWriter](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L675-L714), the `reader` is obtained via `runAsSync` — it's always the manager's current active store. The writer is the passed-in store. `setActive` overrides this when resolving conflicts: it passes `conflict.storage` as `activeSync`, so the "reader" in that call is the conflicting active — but the writer is the new active. This is how [setActive line 778](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L776-L786) merges conflicts into the target.

### 2.2 `syncFromReader` exists and is the real "one-way pull"

[syncFromReader](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L632-L673) pulls from a reader into the manager's active (writer). It's used for initial population when adding a new store backed by existing data. The [line 660](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L660) strips `chunk.user.activeStorage` so that a pull never changes which store the user considers active.

### 2.3 setActive direction

[setActive](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L736-L826) data direction:
1. If `_conflictingActives` exist: pull each into `newActive` via syncToWriter (reader=conflict, writer=newActive). Then `backupSource = newActive`.
2. Else: `backupSource = _active` (the current active).
3. Call `backupSource.storage.setActive(auth, newActiveIdentityKey)` — writes `user.activeStorage = newActiveIdentityKey` on `backupSource`.
4. Push from `backupSource` to every other store via syncToWriter. The mergeUser step propagates the new `user.activeStorage`.

So on a local→remote flip with no conflicts: old-active (local) pushes to remote (new active). On a remote→local flip: old-active (remote) pushes to local. **Data always flows from the currently-active store**, not from the incoming-active target.

### 2.4 Bidirectional conflict resolution

When two stores have diverged (both have `user.activeStorage = themselves`), makeAvailable puts them both in _conflictingActives (except whichever came first as default `_active`). [Mutations are blocked](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L119-L121) until `setActive` is called, which forcibly merges every conflict into the chosen winner. The merge uses per-entity last-writer-wins (LWW) on `updated_at`, so the most recently modified row wins field-by-field per [EntityOutput.mergeExisting](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityOutput.ts#L262-L289) and its siblings.

### 2.5 Checkpoints per direction

`EntitySyncState` is keyed by the **writer** on `(userId, storageIdentityKey=from, storageName)` via [findOrInsertSyncStateAuth](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageReaderWriter.ts#L346-L370). This means each pair (reader, writer) has ONE checkpoint row — stored on the writer. Therefore:
- A→B push has one sync_state row on B with storageIdentityKey=A's.
- B→A push has a separate sync_state row on A with storageIdentityKey=B's.
- The `when` cursors for each direction are independent.

This is necessary because the idMaps translate A's local IDs into B's local IDs in one direction; the reverse direction needs the opposite mapping.

---

## Section 3: Duplicate-row failure mode — `WERR_BAD_REQUEST: Result must be unique`

### 3.1 The exact query and the exact throw

[EntityOutput.mergeFind](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityOutput.ts#L231-L251):

```ts
const transactionId = syncMap.transaction.idMap[ei.transactionId]
const basketId = ei.basketId ? syncMap.outputBasket.idMap[ei.basketId] : null
const ef = verifyOneOrNone(
  await storage.findOutputs({
    partial: { userId, transactionId, vout: ei.vout },
    trx
  })
)
```

[verifyOneOrNone](/Users/davidcase/Source/1sat/wallet-toolbox/src/utility/utilityHelpers.ts#L158-L161) throws `WERR_BAD_REQUEST('Result must be unique.')` when `results.length > 1`.

### 3.2 The IndexedDB index is unique

[outputs.createIndex('transactionId_vout_userId', ['transactionId', 'vout', 'userId'], { unique: true })](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L239). So two rows in `outputs` where all three fields match is **impossible via normal inserts** — IDB would reject the second insert with a `ConstraintError`.

### 3.3 How duplicates nonetheless arrive at the query

The query uses `findOutputs({partial: {userId, transactionId, vout}})`. The branching in [StorageIdb.findOutputs](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L1557-L1607) decides which index to open:

```ts
if (args.partial?.userId !== undefined) {
  if (args.partial?.transactionId && args.partial?.vout !== undefined) {
    // open the unique compound index cursor — correct path
  } else {
    // fall through to opening the userId index cursor
    cursor = await dbTrx.objectStore('outputs').index('userId').openCursor(args.partial.userId)
  }
}
```

Note line [1560](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L1560): `if (args.partial?.transactionId && args.partial?.vout !== undefined)` — the `transactionId` branch uses **truthy** check. If `transactionId === undefined` (or `=== 0`), this path is **skipped** and the cursor is opened on the non-unique `userId` index.

Then the post-filter at line [1587](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L1587): `if (args.partial.transactionId && r.transactionId !== args.partial.transactionId) continue` — also truthy check. With `transactionId === undefined`, the filter is skipped entirely, so **every output belonging to `userId` at that `vout` is returned**. If the user has two or more outputs across different transactions at the same vout (extremely common — many transactions have a vout=0 change output), the verifyOneOrNone throws.

### 3.4 When does `syncMap.transaction.idMap[ei.transactionId]` become `undefined`?

The input `ei.transactionId` is the **reader-side** (source-storage) transaction primary key. `syncMap.transaction.idMap` maps reader-id → writer-id for transactions seen in THIS sync cycle.

It is `undefined` when the reader-side transaction whose ID is `ei.transactionId` was NOT merged earlier in the current merge pass or earlier in the current sync session, AND was not cached from a prior cycle. This can happen:

**(a) A chunk contains outputs referencing a transactionId whose transaction row is missing from the chunk AND missing from idMap.** The reader-side `getSyncChunk` pages each entity independently. With the TS reader ([getSyncChunk.ts](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/methods/getSyncChunk.ts)), transactions are paged BEFORE outputs for a given `since` window; a new transaction added after `since` gets paged in along with its new outputs. But if the output has a non-null `transactionId` pointing at an OLD transaction (before `since`), that transaction row is NOT in any chunk. Its idMap entry must have been populated in a PRIOR sync cycle.

**(b) The idMap was emptied between cycles.** `processSyncChunk` resets `me.esm.count = 0` on done ([line 382](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L382)) but **does NOT reset idMap**. So idMaps accumulate across cycles. This is correct behavior — idMaps are lifetime-sticky.

**(c) A brand-new writer store with a non-empty reader.** On first sync, idMap is empty. Outputs come in referencing transactions that ARE in the chunk, so the order `transaction → output` in [processSyncChunk](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L334-L346) populates idMap.transaction entries before they are consumed by the output merger. As long as the reader includes every referenced transaction in some chunk of the current cycle (or in the same chunk as the output), this works.

**(d) Reader returns stale data — transaction `updated_at` is older than `since` but its outputs are newer.** If a transaction row's `updated_at` falls behind `since` but one of its outputs has been updated to be `>= since` (spendable toggled, spentBy set, lockingScript trimmed), the output will be paged but the transaction won't. On a sync cycle starting with an empty idMap (e.g., after store reconstruction), this yields an unmapped `ei.transactionId` → duplicate-result failure.

**(e) Reader and writer idMaps diverge across multiple active-flips.** When you flip local→remote, the sync_state on remote gets idMap entries mapping local-transaction-id → remote-transaction-id. When you flip back remote→local, a NEW sync_state is created on LOCAL with storageIdentityKey=remote's. Its idMap starts empty and maps remote-ids → local-ids. If an output at `since=undefined` initial pull comes with `ei.transactionId = <remote-id>`, and the corresponding remote transaction is NOT paged in this cycle (because its updated_at is older than the output's), the idMap lookup fails. Result: the IDB cursor falls to the userId-only path and returns all outputs — triggering the error.

This matches the user's observed reproducer: **rapid active flips local→remote→local**.

### 3.5 Legitimate multi-row at `(userId, transactionId, vout)` — ruled out

The unique index on [outputs](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L239) prevents two rows with the same `(transactionId, vout, userId)`. The TS IDB insert path uses `store.add` (see [StorageIdb insertOutput](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts)) which respects the constraint. `updateOutput` would also fail if it attempted to change a row into a collision. So the data table itself is consistent; the failure is **query-side**: the wrong index is used with insufficient filters, producing a multi-row match.

### 3.6 Key-invariant question: what does `findOutputs` with `transactionId=undefined` legitimately want?

Nothing in the sync path wants this. Every caller has a concrete transactionId. The branching code path is defensive for non-sync callers and silently misbehaves for the sync caller when its inputs are invalid. See [Gap G6](#section-5-compatibility-gaps) in Section 5.

---

## Section 4: Go implementation survey

### 4.1 Counterpart mapping

| Concern | TS | Go |
|---|---|---|
| Manager | [WalletStorageManager](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/WalletStorageManager.ts#L55) | [WalletStorageManager](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/storage_manager.go) |
| Provider | [StorageProvider](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageProvider.ts) | [Provider](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/provider.go) |
| RPC client | [StorageClient](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/remoting/StorageClient.ts) | [pkg/storage/client.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/client.go) |
| RPC server | [StorageServer](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/remoting/StorageServer.ts) | [pkg/storage/rpcserver/rpc_server.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/rpcserver/rpc_server.go), wired by [rpc_storage_provider.gen.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/rpcserver/rpc_storage_provider.gen.go) |
| SyncState entity | [EntitySyncState](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts) | [entity.SyncState + chunk_processor](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go) + [sync_map.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/wdk/sync_map.go) |
| Merge driver | [MergeEntity](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/MergeEntity.ts) | Inlined per-entity in [ChunkProcessor.Process](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L57-L153) |
| Per-entity Entity classes | [EntityOutput, EntityTransaction, …](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/) | No counterpart; logic inlined in ChunkProcessor + repo Upsert\*ForSync |
| getSyncChunk | [methods/getSyncChunk.ts](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/methods/getSyncChunk.ts) | [sync/sync_chunk_action.go + chunker_*.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/sync_chunk_action.go) |
| processSyncChunk | [StorageProvider.processSyncChunk](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageProvider.ts#L624) | [Provider.ProcessSyncChunk → ChunkProcessor.Process](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/provider.go#L765-L782) |
| setActive | [StorageReaderWriter.setActive](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageReaderWriter.ts#L96-L100) | [Provider.SetActive](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/provider.go#L173-L193) |

### 4.2 `processSyncChunk` in Go

Present: [Provider.ProcessSyncChunk](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/provider.go#L765) calls [NewChunkProcessor(...).Process](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L57). It processes these entities in order: user, basket, provenTxReq, provenTx, transaction, output, label, labelMap, tag, tagMap — and **SKIPS** certificates, certificateFields, commissions entirely. See [chunk_processor.go#L90-L142](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L90-L142).

### 4.3 `mergeFind/mergeNew/mergeExisting` equivalents

Go collapses these into single `Upsert*ForSync` repo methods. No LWW `updated_at` comparison. Examples:

- [sync_transaction.go UpsertTransactionForSync](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/repo/syncrepo/sync_transaction.go#L85-L146): `UPDATE WHERE reference = ?` (with userId scope), else `INSERT`. Blindly overwrites all fields regardless of whether the chunk row is older than the local row. TS's [EntityTransaction.mergeExisting](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityTransaction.ts#L263-L293) gates on `ei.updated_at > this.updated_at`.
- [sync_output.go upsertOutput](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/repo/syncrepo/sync_output.go#L123-L191): `UPDATE WHERE user_id = ? AND transaction_id = ? AND vout = ?`, else `INSERT`. Again no LWW guard. Similar for [sync_knowntx.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/repo/syncrepo/sync_knowntx.go#L79-L133).

### 4.4 EntitySyncState tracking

Go uses its own [wdk.SyncMap](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/wdk/sync_map.go#L10) (map[EntityName]*SyncMapEntity), persisted as JSON in `sync_states.sync_map`. Semantics match TS: `idMap`, `maxUpdated_at`, `count`. But there is one cursor divergence — [updateSyncStateOnDone](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L762-L780) adds a nanosecond to `when`:

```go
p.syncState.When = to.Ptr(p.syncState.When.Add(time.Nanosecond))
```

TS does not do this ([EntitySyncState.ts#L381](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L381) just `this.when = maxUpdated_at`). TS relies on `updated_at > since` (strict) in some paths and `>=` in others — this is inconsistent inside TS itself and the nanosecond bump in Go paves over it. In practice: if Go's local database is rounding `updated_at` to less than nanosecond granularity (SQLite default is microseconds; MySQL default is seconds unless `DATETIME(6)`), the bump could actually skip rows. Validate Go's timestamp column precision — if `DATETIME` (1-second granularity), the 1-ns bump is a no-op and fine; if `DATETIME(6)`, it is 1μs = fine; if nanosecond-precision (rare in SQL), the bump could skip.

### 4.5 idMap population

Populated identically via [updateSyncState(...idDictionary{readerID, writerID})](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L674-L696). Only entities that have a distinct primary id pair push to idMap: basket, transaction, output, label, tag — matching the TS entity set that has idMaps. ProvenTx and provenTxReq in TS DO have idMaps; in Go these collapse into KnownTx (one table), and KnownTx has **no idMap entry** because Go stores the numeric id via a separate `numeric_id_lookup` table keyed by tx_id. This is a significant architectural divergence — see Gap G1.

### 4.6 `/getSyncChunk` RPC contract

Present: [Provider.GetSyncChunk](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/provider.go#L716-L741) → [sync.NewGetSyncChunkAction](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/sync_chunk_action.go). Returns a `*wdk.SyncChunk` with all 12 entity arrays declared ([storage_request_sync_chunk_args.go#L52-L84](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/wdk/storage_request_sync_chunk_args.go#L52-L84)) but only 9 are populated (no certificate/certificateField/commission chunkers — see [chunkers.go#L3-L14](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunkers.go#L3-L14)).

The offsets order validation differs: TS enforces offsets arrive in chunker order ([getSyncChunk.ts#L236-L237](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/methods/getSyncChunk.ts#L236-L237)). Go builds a lookup map ([sync_chunk_action.go#L92-L98](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/sync_chunk_action.go#L92-L98)) and does not care about order. In practice TS clients send offsets in TS order: `provenTx, outputBasket, outputTag, txLabel, transaction, output, txLabelMap, outputTagMap, certificate, certificateField, commission, provenTxReq`. Go iterates `AllEntityNames` order ([entity_name.go#L23-L36](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/wdk/entity_name.go#L23-L36)): `provenTx, outputBasket, transaction, provenTxReq, txLabel, txLabelMap, output, outputTag, outputTagMap, certificate, certificateField, commission`. Because Go uses a map, this still works — but if the Go client ever talks to a TS server, the TS server would throw (offsets must arrive in its chunker order).

### 4.7 `setActive`

[Provider.SetActive](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/provider.go#L173-L193) updates `user.activeStorage` via repo.UpdateUser. Functionally equivalent to [StorageReaderWriter.setActive](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageReaderWriter.ts#L96-L100). The multi-store orchestrator ([WalletStorageManager.SetActive](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/storage_manager.go#L196-L279)) is present in Go too and mirrors TS. But remember: a TS client talking to Go uses Go's Provider.SetActive (simple user field flip), not Go's manager.

---

## Section 5: Compatibility gaps

| # | Severity | Gap |
|---|---|---|
| G1 | **High — data loss** | Proven-tx identity model divergence (KnownTx vs ProvenTx+ProvenTxReq split) |
| G2 | **High — data loss** | Go `processSyncChunk` drops certificates, certificateFields, commissions entirely |
| G3 | **High — sync breakage** | Go overwrites local rows with older chunks (no LWW `updated_at` guard) |
| G4 | **Medium — sync drift** | Go adds 1ns to `when`; TS does not. Asymmetric cursor advance |
| G5 | **Medium — data integrity** | Go `outputs` table lacks the unique index on `(user_id, transaction_id, vout)` |
| G6 | **Medium — client-side sync breakage** | TS `findOutputs` silently misbehaves when `transactionId=undefined` |
| G7 | **Low — correctness** | Go offset order not validated; mismatch surface with TS server |
| G8 | **Low — behavior drift** | Go `provenTxReq.History.Notify` stubbed to "{}" |
| G9 | **Low — correctness** | Go Output `vout` is uint32; TS uses number (positive int). Cross-platform serialization fine, but int overflow edge exists |
| G10 | **Low — partial sync** | Go ignores tag id mapping in Output upsert (no Tags population during sync) |
| G11 | **Low — correctness** | Go `transaction.reference` has unique index WITHOUT user scope |
| G12 | **Medium — sync breakage** | Go `UpsertKnownTxForSync` deletes and recreates TxNote history on every update |
| G13 | **Low — API drift** | Go `sync_states.refNum` has unique index; TS does not enforce |
| G14 | **Low — behavior** | Go does not validate `chunk.user.identityKey` against current auth like TS does via StorageServer |

### G1 — Proven-tx identity split (High, data loss)

- TS: `provenTxs` (mined) and `provenTxReqs` (in-flight) are two tables each with its own primary-key sequence, both with `idMap` entries in syncMap. See [EntityProvenTx](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityProvenTx.ts), [EntityProvenTxReq](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityProvenTxReq.ts). Cross-refs: `transaction.provenTxId` is resolved via `syncMap.provenTx.idMap`.
- Go: Collapsed into a single `KnownTx` table keyed by `tx_id`. Numeric id lookups done via a separate `numeric_id_lookup` table. See [sync_knowntx.go#L79-L133](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/repo/syncrepo/sync_knowntx.go#L79-L133). No `idMap` entries are populated for `ProvenTxEntityName` or `ProvenTxReqEntityName`. In [chunk_processor.go upsertProvenTxReqs](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L208-L238) — notice the `updateSyncState` call at line 232 is called with NO idDictionary. Same in [upsertProvenTx](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L264-L289).
- **Why it matters**: When a TS client later reads transactions back from a Go writer (e.g., syncFromReader, or after active-flip), any `transaction.provenTxId` field returned by Go will be a numeric value from a different keyspace (`numeric_id_lookup.num_id`) than the original. Cross-references are not round-trip-safe. Transactions whose `provenTxId` was set on the TS side will come back with a *different* numeric provenTxId after round-tripping through Go.
- **Remediation**: either populate both `syncMap.provenTx.idMap` and `syncMap.provenTxReq.idMap` with (reader_id → num_id) bindings, or ensure the TS client never relies on numeric provenTxId stability across storage migrations (audit the call sites of transaction.provenTxId).

### G2 — Missing certificate/commission sync (High, data loss)

- TS: [EntitySyncState.processSyncChunk](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L334-L346) processes certificate, certificateField, commission via `EntityCertificate.mergeFind`, `EntityCertificateField.mergeFind`, `EntityCommission.mergeFind`.
- Go: [chunk_processor.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go) has no branches for these. No chunkers in [chunkers.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunkers.go). No references to `Certificates`, `Commissions`, `CertificateFields` fields of `SyncChunk` anywhere under `pkg/storage/internal/sync`.
- **Why it matters**: When a TS client has local certificates or commissions and flips to the Go server as active, those certificates are silently dropped (the chunk's certificate array is sent, but Go ignores it). On the reverse flip, the Go reader returns empty `certificates: []`, so TS clients that sync-pull believe the user has no certificates. Real data loss on cross-store active flips.
- **Severity rationale**: Certificates are identity primitives. Losing them breaks discovery/attestation. Commissions are billing primitives.
- **Remediation**: implement `UpsertCertificateForSync`, `UpsertCertificateFieldForSync`, `UpsertCommissionForSync` repos and corresponding `upsertCertificate`, `upsertCertificateField`, `upsertCommission` branches in ChunkProcessor. Add corresponding chunkers.

### G3 — Go blind overwrite, no LWW (High, sync breakage)

- TS [EntityOutput.mergeExisting](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityOutput.ts#L262-L289): gated on `if (ei.updated_at > this.updated_at)`. If local is newer, skip. Same pattern in [EntityTransaction.mergeExisting](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityTransaction.ts#L263-L293) and every other entity.
- Go [sync_output.go#L147-L158](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/repo/syncrepo/sync_output.go#L147-L158): unconditionally `Updates(&model)`. Same for [sync_transaction.go#L104-L126](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/repo/syncrepo/sync_transaction.go#L104-L126) and [sync_knowntx.go#L96-L114](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/repo/syncrepo/sync_knowntx.go#L96-L114).
- **Why it matters**: In a bidirectional sync scenario — TS wallet A and Go remote are both "active" at different times — a Go server propagation of an older chunk can overwrite newer local state. Concrete scenario: TS writes an output with spendable=false (spent locally), local updated_at=T2. Active flip to Go — during the sync, Go receives outputs but the `since` cursor on some chunks might see this output as already-processed. Later, a backup sync from the other direction sends the OLD output (spendable=true, updated_at=T1). Go writes T1 over T2 because there's no `WHERE updated_at < ?` guard.
- **Severity rationale**: LWW is the *entire* conflict-resolution story. Without it, simultaneous edits on two stores produce arbitrary winners.
- **Remediation**: add a `WHERE updated_at < ?` clause to each upsert's UPDATE branch. On RowsAffected=0 with an existing row (i.e. the row exists but was newer), don't fall through to INSERT; just return.

### G4 — `when` nanosecond bump asymmetry (Medium)

- TS [EntitySyncState.processSyncChunk#L381](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L381): `this.when = maxUpdated_at`.
- Go [chunk_processor.go#L768-L772](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L768-L772): `when = maxUpdated_at + 1ns`.
- **Why it matters**: Go's getSyncChunk uses `since` with a strictly-`>` comparator (see queryopts.Since), but TS getSyncChunk uses `args.since > r.updated_at` which is strict `>` as well ([StorageIdb.ts#L1583](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L1583) — `if (args.since && args.since > r.updated_at) continue`). Both strict `>`. So both should skip rows with `updated_at === since` — which matches the "already processed" row. But TS sets `when = maxUpdated_at`, so on the NEXT cycle, rows with `updated_at === when` are skipped. Correct. Go sets `when = maxUpdated_at + 1ns`: on the next cycle, rows with `updated_at >= maxUpdated_at` (up to 1ns less than maxUpdated_at+1ns) are skipped. Equivalent — assuming nanosecond precision on the database side.
- In SQLite/MySQL with microsecond precision, the 1-ns bump is effectively `when = maxUpdated_at + 0`, i.e. identical to TS.
- In Postgres with microsecond precision, same.
- **Severity**: cosmetic except on a database engine with true nanosecond precision on `updated_at`. Unlikely to bite in practice. Still a divergence worth aligning.
- **Remediation**: drop the `+ time.Nanosecond` in Go or justify it as a targeted fix for a specific DB engine.

### G5 — Missing unique index on Go outputs (Medium)

- TS: [outputs unique index](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L239) `['transactionId', 'vout', 'userId'], { unique: true }`.
- Go: [models/output.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/database/models/output.go): `UserID`, `TransactionID`, `Vout` each declared `gorm:"index"` — non-unique. No composite unique index.
- **Why it matters**: Nothing prevents the Go server from producing two rows at the same `(user_id, transaction_id, vout)`. Because `upsertOutput` uses `WHERE user_id = ? AND transaction_id = ? AND vout = ?` then `.Updates(&model)`, GORM emits an UPDATE with that WHERE. If two rows already exist (via some race between concurrent upserts — e.g., two parallel sync chunks in flight), both get updated, then INSERT is skipped. OK functionally, but the invariant is unguarded, and any future bug that inserts a duplicate by some other path would go undetected.
- **Remediation**: add a composite unique index on `(user_id, transaction_id, vout)` in the Output model. Backfill migration needed if any duplicates exist in prod.

### G6 — TS findOutputs silent mis-query when transactionId is nil (Medium)

- [StorageIdb.findOutputs#L1559-L1567](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L1559-L1567) and post-filter [#L1587](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L1587): truthy-check on `transactionId` — when `undefined`, falls to `userId` cursor and the post-filter is a no-op.
- **Why it matters**: This is the *immediate* trigger of the `WERR_BAD_REQUEST` error when `syncMap.transaction.idMap[ei.transactionId]` is undefined (see Section 3.4). The current behavior makes a latent idMap gap visible as a confusing crash rather than an informative one.
- **Remediation**: at top of [EntityOutput.mergeFind](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityOutput.ts#L231-L251), add `if (transactionId === undefined) throw new WERR_INTERNAL('output sync: unmapped transactionId ${ei.transactionId} — idMap inconsistency')`. Also fix the defensive branches in `findOutputs` to use `!== undefined` tests.

### G7 — Offsets order not validated in Go (Low)

- TS: [getSyncChunk.ts#L236-L237](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/methods/getSyncChunk.ts#L236-L237) throws if offsets arrive out of order.
- Go: [sync_chunk_action.go#L92-L98](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/sync_chunk_action.go#L92-L98) builds a lookup map; order-agnostic.
- **Why it matters**: Not a runtime failure for TS→Go (Go is permissive). Failure direction is Go→TS: if a Go client were to ever hit a TS server, offsets sent in `AllEntityNames` order would fail TS's strict check.
- **Remediation**: either add order validation on Go side matching TS, or keep Go permissive and document it.

### G8 — ProvenTxReq.Notify is hardcoded `"{}"` in Go (Low)

- Go [sync_knowntx.go#L199](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/repo/syncrepo/sync_knowntx.go#L199): `Notify: "{}"` with a TODO.
- **Why it matters**: TS side uses notify to know which transactions to update after proof arrives. For sync, the notify payload is opaque from the server's perspective — but if a TS client round-trips a ProvenTxReq through Go, the notify is lost.
- **Remediation**: persist the opaque notify blob as a string field on KnownTx and return it unchanged.

### G9 — Integer width

- TS: `vout: number` (JS number, effectively 53-bit). Go: `Vout uint32`.
- **Why it matters**: Out-of-range vouts could be truncated. Not exploitable (no real-world vout > 2^32). Compatibility noise.
- **Remediation**: none urgent.

### G10 — Tags dropped in Output upsert (Low→Medium)

- Go [chunk_processor.go#L388-L392](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L388-L392): `Tags: nil, // TODO`. Output rows synced from a reader lose their tag associations.
- **Why it matters**: TagMaps are sent separately (later in the chunk) so in principle Tags on the Output struct are redundant. But if the TS side expects both to be populated (it does, via the chunk's `outputTags` and `outputTagMaps` arrays), and Go doesn't persist TagMap-to-output relations properly, tag-based listOutputs queries return empty on the Go side after a sync.
- **Evidence**: [upsertTagMap](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L595-L659) IS implemented and does populate the output_tags join table. So this TODO on the Output struct's Tags field is probably cosmetic. Downgrading to Low.

### G11 — `transaction.reference` globally unique in Go (Low)

- Go [models/transaction.go#L14](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/database/models/transaction.go#L14): `Reference string gorm:"uniqueIndex"`.
- TS: reference is generated random; collisions across users are astronomically unlikely. But the schema contract differs: TS IDB has `transactionsStore.createIndex('reference', 'reference', { unique: true })` ([StorageIdb.ts#L216](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L216)) — also global. So this is actually consistent. Downgrading to N/A.

### G12 — Go deletes/recreates TxNote history on every upsert (Medium)

- Go [sync_knowntx.go#L104-L112](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/repo/syncrepo/sync_knowntx.go#L104-L112): on every update to KnownTx, it DELETEs all TxNotes for the txid and re-adds from the chunk. Without an LWW guard, an older chunk will destroy newer history notes. Combined with G3, a delayed mirror-sync could wipe history.
- **Remediation**: merge history by appending unseen notes instead of delete-all-recreate. Or add a monotonicity guard.

### G13 — `sync_states.refNum` unique index (Low)

- Go [models/sync_state.go#L19](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/database/models/sync_state.go#L19): `RefNum string gorm:"not null;uniqueIndex"`. TS also has `refNum` unique.
- No divergence. Listed for completeness.

### G14 — Auth identityKey validation on processSyncChunk (Low)

- TS StorageServer [line 182-184](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/remoting/StorageServer.ts#L182-L184): validates `params[0] !== req.auth.identityKey` for findOrInsertUser (and others via validateParam0).
- Go [ProcessSyncChunk](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/provider.go#L765-L782): calls `validate.ValidRequestSyncChunkArgs` ([validate_request_sync_chunk_args.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/validate/validate_request_sync_chunk_args.go)) which only checks args are present; does NOT check `args.IdentityKey == auth.IdentityKey`. The repo lookup `p.repo.FindUser(ctx, args.IdentityKey)` would succeed for ANY user's identityKey if the auth is established — potentially allowing a caller to write sync data to another user's account.
- **Remediation**: add identityKey-vs-auth validation at the top of `ProcessSyncChunk` (same for `GetSyncChunk`).

---

## Section 6: Bug triage — WERR_BAD_REQUEST ranking

### Ranked causes

**1. (Most likely) Idmap gap in TS after rapid active flips — Section 3.4 scenarios (d) and (e)**

Evidence supporting:
- The bug is thrown by TS-side [verifyOneOrNone](/Users/davidcase/Source/1sat/wallet-toolbox/src/utility/utilityHelpers.ts#L158-L161) — meaning the TS local IDB is queried, not the Go remote.
- The stack names [EntityOutput.mergeFind](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityOutput.ts#L240-L245) specifically, which is the only query in the sync pipeline that uses `findOutputs({partial: {userId, transactionId, vout}})`.
- The IDB schema ([StorageIdb.ts#L239](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L239)) guarantees at most 1 row per `(transactionId, vout, userId)` on normal inserts, so the >1 result is only explainable by the cursor query falling back to the `userId` index — which happens only when `transactionId` arg is falsy (undefined/0).
- `transactionId` becomes undefined specifically when `syncMap.transaction.idMap[ei.transactionId]` returns undefined — i.e., when the output's parent transaction is neither in the current chunk nor was merged in an earlier chunk/cycle whose idMap survived in the sync_states row.
- The user's reproducer ("rapid active flips local→remote→local") sets up exactly scenario (e): a freshly-created sync_states row with empty idMap, receiving outputs whose parent transactions were written in cycles ago (so their `updated_at` is older than any reasonable `since`, so they are not re-paged), but the outputs themselves are newer (spentBy/spendable just changed).

Evidence against:
- Could be ruled out if we saw the sync_states row's stored idMap AND the chunk payload. We don't have them here.

Confidence: **High (~75%)**.

**2. Missing update-vs-insert branch on Go — G3 blind overwrite creating orphans**

Evidence supporting: Go blindly overwrites rows. If Go's outputs table has duplicates (which G5 permits — no unique index), then when a TS client pulls a chunk from Go containing two rows at `(same userId, same transactionId, same vout)`, the TS-side `insertOutput` would throw during the first insert and the second during any mergeFind. But actually — the read happens BEFORE the insert. So if Go returns 2 outputs for the same key, TS findOutputs on LOCAL (after writing one) would see both — no, that doesn't fit the stack.

Actually let me reconsider: the stack is `syncToWriter → processSyncChunk → EntitySyncState.processSyncChunk → MergeEntity.merge → EntityOutput.mergeFind → findOutputs`. The writer in the failure stack is TS-local (the target of syncToWriter). What's being queried is the *local* outputs table. So: if the local outputs table already contains TWO rows at `(userId, tid, vout)`, mergeFind returns >1. For that to happen, an earlier insert pathway must have violated the uniqueness. A corrupted local IDB could happen if a schema migration dropped and reinstated the index. Unlikely but not impossible.

Confidence: **Low (~10%)** that this is root cause; **high** that it's a contributing risk.

**3. Go server returning chunks that violate TS merger invariants**

Evidence supporting: Go does not populate `provenTx.idMap` (G1). It does not send certificates/commissions (G2). But none of those cause the output mergeFind failure directly.

One way Go could cause the issue: the Go reader paginates transactions and outputs in separate cycles of `addItems`. Looking at [Go chunker_user_transactions.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunker_user_transactions.go) and [chunker_outputs.go](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunker_outputs.go), each chunker is called once per ChunkingState round within a single getSyncChunk call. If Go's transactions chunker saturates on page 1 (returns max pageSize transactions) and the outputs chunker then adds outputs referencing a transaction in page 2 of transactions (which weren't returned in this chunk because the transactions chunker has no more budget) — the outputs in the chunk reference a transactionId that isn't in the same chunk.

That alone is fine if the transaction was already in idMap from a prior chunk. The failure requires the prior idMap to be lost.

Can Go's ProcessSyncChunk fail to persist the idMap? Looking at [chunk_processor.go#L144-L148](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L144-L148) — it calls `repo.UpdateSyncState` at end of Process(). On an empty chunk, it calls [updateSyncStateOnDone](/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L762-L780) which resets counts but DOES write the sync_state. OK — persistence is fine on the Go side. But this is about TS as writer, so the Go server isn't the writer. Not relevant.

Confidence: **Low (~5%)** for the specific WERR. But high that Go returning stale/misordered chunks compounds the idMap gap.

**4. Schema constraints not enforced — partial reset**

If the local IDB schema was created without the unique index (older schema version), a dual-write bug could have left two rows. Then mergeFind would genuinely find 2.

Evidence against: The schema at [line 239](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/StorageIdb.ts#L239) is in the onUpgradeNeeded function; once a schema is created it persists. Upgrades that change this index would need explicit migration code. Absent evidence of prior schema versions in the user's deployment, this is unlikely.

Confidence: **Low (~10%)**.

### Reproduction test plan

To confirm hypothesis #1 (idMap gap), at the failure point, log:
- The current `syncMap.transaction.idMap` contents.
- The value of `ei.transactionId`.
- The value of `transactionId` after the lookup.
- The `userId` and `vout`.

If `transactionId === undefined` in the failing path, hypothesis #1 is confirmed. Fix: apply remediation G6 (throw with context from `mergeFind` when the idMap lookup fails). Then engineer a proper remediation: either ensure the reader returns every referenced transaction in each sync cycle where its outputs appear, OR populate idMap defensively by querying the local transactions table by some stable key (txid) when the mapping is missing.

The txid-based fallback is implementable: if `syncMap.transaction.idMap[ei.transactionId] === undefined`, query local transactions by `{userId, reference: ??}` — but `ei.reference` is not on the Output row. Alternative: cache the reader's transaction rows by `txid` in the chunk, and allow a second-pass lookup.

A more robust structural fix: change `EntityOutput.mergeFind`'s fallback key to `{userId, txid, vout}` when `transactionId` maps to undefined. The output's `txid` IS on the chunk row (`ei.txid`). That would recover the correct single row. The local IDB does not have a unique index on `(userId, txid, vout)`, but a non-unique index on `txid` exists and the post-filter on userId+vout would be exact.

---

## Deliverable summary

- **Report path**: not written. The session has only Read/Grep/Glob/TodoWrite/Skill tools available — no Write/Edit/Bash. Findings are returned inline above.
- **Gap count by severity**: 4 High, 4 Medium, 6 Low (one downgraded to N/A after verification). Total 14 identified, 13 actionable.
  - High (4): G1 (KnownTx split), G2 (missing cert/commission sync), G3 (no LWW), G12 (TxNote destructive rewrite) — but G12 is also "Medium" — treat as 3 High + 1 Medium. Final tally: 3 High, 5 Medium, 5 Low, 1 N/A.
- **Primary bug hypothesis**: idMap gap for `transaction` entity during rapid active flips (~75% confidence). Fix at [EntityOutput.mergeFind](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityOutput.ts#L231-L251) should add a txid fallback path AND a loud throw when neither lookup resolves.
- **Blockers**:
  - No Write/Edit/Bash tool available in this session; cannot create `/Users/davidcase/Source/1sat/wallet-toolbox/docs/sync-architecture-review.md`. User can copy the inline content above if the persisted file is desired, or re-run with a session that has Write access.
  - I did not inspect every entity's `mergeExisting` gate in Go's repo layer — spot-checked transaction, output, known_tx only. Other entities (labels, tags, baskets) likely share the same no-LWW pattern but would need per-file verification to enumerate precisely.
  - I did not read the production `sync_states` row contents or a failing chunk payload, so hypothesis #1 is inference, not confirmed diagnosis. A debug log at the failure site is the next concrete step.
