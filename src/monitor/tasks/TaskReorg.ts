import { TableProvenTx } from '../../index.client'
import { BlockHeader } from '../../services/chaintracker/chaintracks/Api/BlockHeaderApi'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * Check the `monitor.deactivatedHeaders` for any headers that have been deactivated.
 * 
 * When headers are found, review matching ProvenTx records and update proof data as appropriate.
 *
 * New deactivated headers are pushed onto the `deactivatedHeaders` array.
 * They must be shifted out as they are processed.
 * 
 * In normal operation there should never be any work for this task to perform.
 * The most common result is that there are no matching proven_txs records because
 * generating new proven_txs records intentionally lags new block generation to
 * minimize this disruption.
 * 
 * It is very disruptive to update a proven_txs record because:
 * - Sync'ed storage is impacted.
 * - Generated beefs are impacted.
 * - Updated proof data may be unavailable at the time a reorg is first reported.
 * 
 * Instead of reorg notification derived from new header notification, reorg repair to
 * the proven_txs table is more effectively driven by noticing that a beef generated for a new
 * createAction fails to verify against the chaintracker.
 * 
 * An alternate approach to processing these events is to revert the proven_txs record to a proven_tx_reqs record.
 * Pros:
 * - The same multiple attempt logic that already exists is reused.
 * - Failing to obtain a new proof already has transaction failure handling in place.
 * - Generated beefs automatically become one generation deeper, potentially allowing transaction outputs to be spent.
 * Cons:
 * - Transactions must revert to un-proven / un-mined.
 */
export class TaskReorg extends WalletMonitorTask {
  static taskName = 'Reorg'

  constructor(
    monitor: Monitor
  ) {
    super(monitor, TaskReorg.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run: this.monitor.deactivatedHeaders.length > 0
    }
  }

  async runTask(): Promise<string> {
    let log = ''

    const ptxs: TableProvenTx[] = []

    await this.storage.runAsStorageProvider(async sp => {
      for (;;) {
        // Lookup all the proven_txs records matching the deactivated headers
        const header = this.monitor.deactivatedHeaders.shift()
        if (!header) break
        const txs = await sp.findProvenTxs({ partial: { blockHash: header.hash } })
        ptxs.push(...txs)
        log += `  block ${header.hash} orphaned with ${txs.length} impacted transactions\n`
      }
    })

    for (const ptx of ptxs) {
      const mpr = await this.monitor.services.getMerklePath(ptx.txid)
      if (mpr.merklePath && mpr.header) {
        const mp = mpr.merklePath
        const h = mpr.header
        const leaf = mp.path[0].find(leaf => leaf.txid === true && leaf.hash === ptx.txid)
        if (leaf) {
          const update: Partial<TableProvenTx> = {
            height: mp.blockHeight,
            index: leaf.offset,
            merklePath: mp.toBinary(),
            merkleRoot: h.merkleRoot,
            blockHash: h.hash
          }
          if (update.blockHash === ptx.blockHash) {
            log += `    txid ${ptx.txid} merkle path update still based on deactivated header ${ptx.blockHash}\n`
          } else {
            await this.storage.runAsStorageProvider(async sp => {
              await sp.updateProvenTx(ptx.provenTxId, update)
            })
            log += `    txid ${ptx.txid} merkle path updated\n`
            if (update.height !== ptx.height)
              log += `      height ${ptx.height} -> ${update.height}\n`
            log += `      blockHash ${ptx.blockHash} -> ${update.blockHash}\n`
            log += `      merkleRoot ${ptx.merkleRoot} -> ${update.merkleRoot}\n`
            log += `      index ${ptx.index} -> ${update.index}\n`
          }
        } else {
          log += `    txid ${ptx.txid} merkle path update doesn't include txid\n`
        }
      } else {
        log += `    txid ${ptx.txid} merkle path update unavailable\n`
      }
    }

    return log
  }
}
