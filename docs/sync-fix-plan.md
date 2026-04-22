# Sync fix plan — launch blockers + diagnostic

## Context

yours-wallet is days from public launch. During testing, a TS client → Go server sync produced `WERR_BAD_REQUEST: Result must be unique.` from `EntityOutput.mergeFind`. Deep-dive investigation (see [sync-architecture-review.md](./sync-architecture-review.md) and [go-client-vs-ts-server-compat.md](./go-client-vs-ts-server-compat.md)) surfaced a set of compatibility gaps between the canonical TS `wallet-toolbox` and the Go port `go-wallet-toolbox`.

Four sync-pipeline gaps were found:

- **G1** — Go server does not populate `syncMap.provenTx.idMap` / `syncMap.provenTxReq.idMap` in sync responses. Silent corruption: TS clients write `null` for `transaction.provenTxId` after every round-trip, severing proof linkage.
- **G2** — Go server silently drops certificates, certificateFields, commissions from sync chunks (read and write).
- **G3** — Go server upsert paths for output, transaction, and knownTx overwrite existing rows unconditionally. No `updated_at` LWW guard. Stale chunks can regress `transaction.status`, `transaction.provenTxId`, `output.spentBy`, `output.spendable`.
- **G8** — Go server hardcodes `ProvenTxReq.notify` to `"{}"` regardless of input; round-trip loses the notify payload.

Separately, the surface-level `WERR_BAD_REQUEST` error itself is a TS-side defensiveness gap: [EntityOutput.mergeFind](/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityOutput.ts#L231-L251) silently allows `transactionId=undefined` to cascade into a fallback userId-only query, which returns multiple rows and throws a confusing "uniqueness" error. The real cause — an unmapped idMap entry — is never surfaced.

**Scope of this plan** (user-selected): launch blockers only, plus the TS-side diagnostic improvement.

- G1 (fix in Go)
- G3 (fix in Go)
- `mergeFind` diagnostic (fix in TS upstream)

G2 and G8 are tracked for later; this plan doesn't include them in the execution set.

---

## Step 0 — File GitHub issues for deferred gaps (preserves context)

Two issues to file against `b-open-io/go-wallet-toolbox` for the gaps we are **not** fixing in this plan (G2, G8). G1, G3, and the TS diagnostic are being fixed directly — no tracking issue needed.

### Issue A — go-wallet-toolbox: sync drops certificate, certificateField, commission entities (G2)

**Title:** `processSyncChunk and getSyncChunk: certificate, certificateField, commission entities never handled`

**Body:**
```
## Problem

The `SyncChunk` contract defines 12 entity arrays. The Go implementation handles 9 and silently drops 3:

- `certificates`
- `certificateFields`
- `commissions`

Evidence:

- `pkg/storage/internal/sync/chunk_processor.go` has no `upsertCertificate` / `upsertCertificateField` / `upsertCommission` branches in the top-level `Process` dispatch (lines 90-142).
- `pkg/storage/internal/sync/chunkers.go` has no chunkers registered for these entities.

When a TS client sends a chunk containing certificates or commissions, the Go server silently ignores them. When the TS client requests a chunk, the Go server returns empty arrays for these entities regardless of stored state.

## RPC-Observable Difference

Cross-device or cross-store sync loses all certificates and commissions silently.

## Impact

Latent for yours-wallet today (does not use certificates). Blocking for "any BRC-100 wallet" positioning — certificates are an identity primitive.

## Suggested Fix

Implement `UpsertCertificateForSync`, `UpsertCertificateFieldForSync`, `UpsertCommissionForSync` in the syncrepo. Add corresponding branches in `chunk_processor.Process`. Register chunkers in `chunkers.go` for `getSyncChunk` responses.

## Severity

High for cross-deployment scenarios, latent for single-wallet yours-wallet.
```

### Issue B — go-wallet-toolbox: `ProvenTxReq.notify` hardcoded to `"{}"` (G8)

**Title:** `UpsertKnownTxForSync: notify field hardcoded, opaque payload lost on round-trip`

**Body:**
```
## Problem

`pkg/internal/storage/repo/syncrepo/sync_knowntx.go` at approximately line 199 hardcodes `Notify: "{}"` with a TODO comment, regardless of the value in the incoming `ProvenTxReq.notify` field. The TypeScript client uses this opaque blob to track which transactions to notify when proofs arrive.

## RPC-Observable Difference

Any `ProvenTxReq` that round-trips through the Go server loses its notify payload.

## Suggested Fix

Add a `notify` string column to the KnownTx model. Persist the incoming value unchanged. Return it unchanged on reads.

## Severity

Low — single-device impact minimal. Tracked for completeness.
```

---

## Step 1 — Fix G1 in go-wallet-toolbox

**File:** `/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go`

**Changes:**

1. Line 232 (`upsertProvenTxReqs`): pass an `idDictionary` to `updateSyncState`:
   ```go
   err = p.updateSyncState(wdk.ProvenTxReqEntityName, chunkProvenTxReq.UpdatedAt, idDictionary{
       readerID: int(chunkProvenTxReq.ProvenTxReqID),
       writerID: <numeric id from UpsertKnownTxForSync>,
   })
   ```

2. Line 283 (`upsertProvenTx`): same pattern with `ProvenTxEntityName`:
   ```go
   err = p.updateSyncState(wdk.ProvenTxEntityName, chunkProvenTx.UpdatedAt, idDictionary{
       readerID: int(chunkProvenTx.ProvenTxID),
       writerID: <numeric id from UpsertKnownTxForSync>,
   })
   ```

**Prerequisite change:** `UpsertKnownTxForSync` in `pkg/internal/storage/repo/syncrepo/sync_knowntx.go` currently returns `(isNew bool, err error)`. Extend it to return the numeric id via the `numeric_id_lookup` table:

   ```go
   func (r *Repo) UpsertKnownTxForSync(ctx context.Context, known *pkgentity.KnownTx) (isNew bool, numericID uint, err error)
   ```

The numeric id is already looked up internally during the upsert — just surface it.

**Testing:**
- Unit test in `chunk_processor_test.go` verifying that after processing a chunk with provenTx and provenTxReq entries, the returned `SyncMap` contains non-empty `idMap` for both entity types.
- Integration test: TS client syncs a transaction with `provenTxId` through Go server, reads back the transaction, verifies `provenTxId` survived round-trip.

---

## Step 2 — Fix G3 in go-wallet-toolbox

**Files:**
- `/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/repo/syncrepo/sync_output.go`
- `/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/repo/syncrepo/sync_transaction.go`
- `/Users/davidcase/Source/1sat/go-wallet-toolbox/pkg/internal/storage/repo/syncrepo/sync_knowntx.go`

**Pattern for each upsert's UPDATE branch:**

Current (approximate):
```go
result := tx.Model(&existingModel).Updates(&incomingModel)
```

Replace with:
```go
result := tx.Model(&existingModel).
    Where("updated_at < ?", incomingModel.UpdatedAt).
    Updates(&incomingModel)
if result.RowsAffected == 0 {
    // Row exists but was newer than incoming — correctly skip, do not fall through to INSERT.
    return false, nil
}
```

The exact GORM idiom may differ per file; the invariant is: an UPDATE that would regress `updated_at` must be skipped, and the skip must not cascade into an INSERT.

**Testing:**
- Unit tests per file: write a row with updated_at=T2, attempt to upsert with updated_at=T1, verify the stored row still has T2 values.
- Also verify the symmetric case: upsert with T3 > T2 successfully updates to T3 values.
- Run existing sync integration tests to confirm no regression in the normal case.

---

## Step 3 — TS-side diagnostic in wallet-toolbox

**File:** `/Users/davidcase/Source/1sat/wallet-toolbox/src/storage/schema/entities/EntityOutput.ts` — `mergeFind` at line 231-251.

**Change:** add the explicit guard after the idMap lookup:

```ts
static async mergeFind(
  storage: EntityStorage,
  userId: number,
  ei: TableOutput,
  syncMap: SyncMap,
  trx?: TrxToken
): Promise<{ found: boolean; eo: EntityOutput; eiId: number }> {
  const transactionId = syncMap.transaction.idMap[ei.transactionId]
  if (transactionId === undefined) {
    throw new sdk.WERR_INTERNAL(
      `output sync: unmapped transactionId ${ei.transactionId} (userId=${userId}, vout=${ei.vout})`
    )
  }
  const basketId = ei.basketId ? syncMap.outputBasket.idMap[ei.basketId] : null
  const ef = verifyOneOrNone(
    await storage.findOutputs({
      partial: { userId, transactionId, vout: ei.vout },
      trx
    })
  )
  return {
    found: !!ef,
    eo: new EntityOutput(ef || { ...ei }),
    eiId: verifyId(ei.outputId)
  }
}
```

Import check: `WERR_INTERNAL` is already imported via the `sdk` namespace (see existing usages in the file).

**Testing:**
- Unit test: construct a `SyncMap` with empty `transaction.idMap`, call `mergeFind` with an output referencing a transactionId not in the map, assert that `WERR_INTERNAL` is thrown with the expected message shape.
- Run existing sync tests to confirm no regression (the guard only fires when the lookup returns undefined; normal paths populate idMap).

---

## Step 4 — Publish and wire through

**go-wallet-toolbox:** Go module consumed by 1sat-stack. After merging, 1sat-stack needs to bump its dependency. That's a separate deployment step on `rack`.

**wallet-toolbox:** TS package. After merging, publish the version bump. Then bump the pin in the `@1sat/wallet` package in the 1sat-sdk monorepo (wallet-toolbox is a peer dep). Full publish wave for `@1sat/wallet` + downstream shims + yours-wallet pin bump, following the same publish pattern used earlier in this iteration.

---

## Verification — end-to-end

1. Deploy fixed Go server to `rack` (or a staging endpoint).
2. yours-wallet points at the updated endpoint.
3. Test sequence that previously reproduced `WERR_BAD_REQUEST`:
   - Start with local-active.
   - Perform a transaction (ensures `transaction.provenTxId` is populated locally).
   - Flip active to remote (`setActiveStorage(url)`).
   - Flip active back to local (`setActiveStorage('local')`).
   - Confirm no `WERR_BAD_REQUEST` thrown.
   - Confirm `transaction.provenTxId` survives the round-trip — use the Storage page's output counts, or read the transaction row directly.
4. Regression bidirectional test:
   - On Go side, manually insert a row with `updated_at = T2`.
   - Trigger a sync with a chunk carrying `updated_at = T1 < T2`.
   - Confirm stored row still reflects T2 state.
5. Diagnostic test (TS upstream):
   - Craft a chunk with an output whose parent transaction is NOT in the syncMap.
   - Confirm the error thrown is the new `WERR_INTERNAL` with the unmapped transactionId, not the old `WERR_BAD_REQUEST`.

---

## Tracked but not in this plan

- G2 — cert/commission sync. Captured as Issue A above. Required for "any BRC-100 wallet" positioning.
- G8 — notify payload round-trip. Captured as Issue B above. Low priority.
- Existing GitHub issues #818, #819, #820, #821, #822 on go-wallet-toolbox — not sync-pipeline related; separate RPC surface gaps.
