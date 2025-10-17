import { TableProvenTx } from '../../index.client'
import { BlockHeader } from '../../services/chaintracker/chaintracks/Api/BlockHeaderApi'
import { DeactivedHeader, Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * Check the `monitor.deactivatedHeaders` for any headers that have been deactivated.
 *
 * When headers are found, review matching ProvenTx records and update proof data as appropriate.
 *
 * New deactivated headers are pushed onto the `deactivatedHeaders` array.
 * They must be shifted out as they are processed.
 *
 * The current implementation ages deactivation notifications by 10 minutes with each retry.
 * If a successful proof update confirms original proof data after 3 retries, the original is retained.
 *
 * In normal operation there should rarely be any work for this task to perform.
 * The most common result is that there are no matching proven_txs records because
 * generating new proven_txs records intentionally lags new block generation to
 * minimize this disruption.
 *
 * It is very disruptive to update a proven_txs record because:
 * - Sync'ed storage is impacted.
 * - Generated beefs are impacted.
 * - Updated proof data may be unavailable at the time a reorg is first reported.
 *
 * Proper reorg handling also requires repairing invalid beefs for new transactions when
 * createAction fails to verify a generated beef against the chaintracker.
 */
export class TaskReorg extends WalletMonitorTask {
  static taskName = 'Reorg'

  process: DeactivedHeader[] = []

  constructor(
    monitor: Monitor,
    public agedMsecs = Monitor.oneMinute * 10,
    public maxRetries = 3
  ) {
    super(monitor, TaskReorg.taskName)
  }

  /**
   * Shift aged deactivated headers onto `process` array.
   * @param nowMsecsSinceEpoch current time in milliseconds since epoch.
   * @returns `run` true iff there are aged deactivated headers to process.
   */
  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    const cutoff = nowMsecsSinceEpoch - this.agedMsecs
    const q = this.monitor.deactivatedHeaders
    while (q.length > 0 && cutoff > q[0].whenMsecs) {
      // Prepare to process deactivated headers that have aged sufficiently (agedMsecs)
      const header = q.shift()!
      this.process.push(header)
    }
    return {
      run: this.process.length > 0
    }
  }

  async runTask(): Promise<string> {
    let log = ''

    for (;;) {
      const header = this.process.shift()
      if (!header) break

      //const rpr = await this.storage.reproveHeader(header.header)

      let ptxs: TableProvenTx[] = []

      await this.storage.runAsStorageProvider(async sp => {
        // Lookup all the proven_txs records matching the deactivated headers
        ptxs = await sp.findProvenTxs({ partial: { blockHash: header.header.hash } })
      })

      log += `  block ${header.header.hash} orphaned with ${ptxs.length} impacted transactions\n`

      let retry = false
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
              if (header.tries + 1 >= this.maxRetries) {
                log += `      maximum retries ${this.maxRetries} exceeded\n`
              } else {
                retry = true
              }
            } else {
              // Verify the new proof's validity.
              const merkleRoot = mp.computeRoot(ptx.txid)
              const chaintracker = await this.monitor.services.getChainTracker()
              const isValid = await chaintracker.isValidRootForHeight(merkleRoot, update.height!)
              const logUpdate = `      height ${ptx.height} ${ptx.height === update.height ? 'unchanged' : `-> ${update.height}`}\n`
              log += `      blockHash ${ptx.blockHash} -> ${update.blockHash}\n`
              log += `      merkleRoot ${ptx.merkleRoot} -> ${update.merkleRoot}\n`
              log += `      index ${ptx.index} -> ${update.index}\n`
              if (!isValid) {
                log +=
                  `    txid ${ptx.txid} chaintracker fails to confirm updated merkle path update invalid\n` + logUpdate
              } else {
                await this.storage.runAsStorageProvider(async sp => {
                  await sp.updateProvenTx(ptx.provenTxId, update)
                })
                log += `    txid ${ptx.txid} proof data updated\n` + logUpdate
              }
            }
          } else {
            log += `    txid ${ptx.txid} merkle path update doesn't include txid\n`
            retry = true
          }
        } else {
          log += `    txid ${ptx.txid} merkle path update unavailable\n`
          retry = true
        }
      }
      if (retry) {
        log += `    retrying...\n`
        this.monitor.deactivatedHeaders.push({ header: header.header, whenMsecs: Date.now(), tries: header.tries + 1 })
      }
    }

    return log
  }
}
