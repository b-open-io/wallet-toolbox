import { ChaintracksStorageBaseOptions, InsertHeaderResult } from '../Api/ChaintracksStorageApi'
import { ChaintracksStorageBase } from './ChaintracksStorageBase'
import { LiveBlockHeader } from '../Api/BlockHeaderApi'
import { addWork, convertBitsToWork, isMoreWork, serializeBaseBlockHeader } from '../util/blockHeaderUtilities'
import { HeightRange } from '../util/HeightRange'
import { BulkFilesReaderStorage } from '../util/BulkFilesReader'
import { ChaintracksFetch } from '../util/ChaintracksFetch'
import { Chain } from '../../../../sdk/types'
import { WERR_INVALID_PARAMETER } from '../../../../sdk/WERR_errors'
import { BlockHeader } from '../../../../sdk/WalletServices.interfaces'
import { IDBPDatabase, IDBPObjectStore, IDBPTransaction, openDB } from 'idb'
import { BulkHeaderFileInfo } from '../util/BulkHeaderFile'

interface ChaintracksIdbData {
  chain: Chain
  liveHeaders: Map<number, LiveBlockHeader>
  maxHeaderId: number
  tipHeaderId: number
  hashToHeaderId: Map<string, number>
}

export interface ChaintracksStorageIdbOptions extends ChaintracksStorageBaseOptions {}

export class ChaintracksStorageIdb extends ChaintracksStorageBase {

  dbName: string

  db?: IDBPDatabase<ChaintracksStorageIdbSchema>

  whenLastAccess?: Date

  allStores: string[] = [
    'live_headers',
    'bulk_headers'
  ]


  constructor(options: ChaintracksStorageIdbOptions) {
    super(options)
    this.dbName = `chaintracks-${this.chain}net`
  }

  override async migrateLatest(): Promise<void> {
    if (this.db) return
    this.db = await this.initDB()
  }

  async initDB(): Promise<IDBPDatabase<ChaintracksStorageIdbSchema>> {
    const db = await openDB<ChaintracksStorageIdbSchema>(this.dbName, 1, {
      upgrade(db, oldVersion, newVersion, transaction) {
        if (!db.objectStoreNames.contains('live_headers')) {
          const liveHeadersStore = db.createObjectStore('live_headers', {
            keyPath: 'headerId',
            autoIncrement: true
          })
          liveHeadersStore.createIndex('hash', 'hash', { unique: true })
          liveHeadersStore.createIndex('height', 'height', { unique: false })
          liveHeadersStore.createIndex('previousHash', 'previousHash', { unique: false })
          liveHeadersStore.createIndex('isActive', 'isActive', { unique: false })
          liveHeadersStore.createIndex('isChainTip', 'isChainTip', { unique: false })
          liveHeadersStore.createIndex('activeTip', ['isActive', 'isChainTip'], { unique: false })
        }

        if (!db.objectStoreNames.contains('bulk_headers')) {
          const bulkHeadersStore = db.createObjectStore('proven_tx_reqs', {
            keyPath: 'fileId',
            autoIncrement: true
          })
          bulkHeadersStore.createIndex('firstHeight', 'firstHeight', { unique: true })
        }
      }
    })
    return db
  }

  toDbTrxReadOnly(
    stores: string[]
  ): IDBPTransaction<ChaintracksStorageIdbSchema, string[], 'readonly'> {
    if (!this.db) throw new Error('not initialized')
    const db = this.db
    const trx = db.transaction(stores || this.allStores, 'readonly')
    this.whenLastAccess = new Date()
    return trx
  }

  toDbTrxReadWrite(
    stores: string[]
  ): IDBPTransaction<ChaintracksStorageIdbSchema, string[], 'readwrite'> {
    if (!this.db) throw new Error('not initialized')
    const db = this.db
    const trx = db.transaction(stores || this.allStores, 'readwrite')
    this.whenLastAccess = new Date()
    return trx
  }


  override async destroy(): Promise<void> {}

  override async deleteLiveBlockHeaders(): Promise<void> {
    if (!this.db) throw new Error('not initialized')
    await this.db?.clear('live_headers')
  }

  /**
   * Delete live headers with height less or equal to `maxHeight`
   * 
   * Set existing headers with previousHeaderId value set to the headerId value of
   * a header which is to be deleted to null.
   *
   * @param maxHeight delete all records with less or equal `height`
   * @returns number of deleted records
   */
  override async deleteOlderLiveBlockHeaders(maxHeight: number): Promise<number> {
    if (!this.db) throw new Error('not initialized')

    const trx = this.toDbTrxReadWrite(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')
    const previousHeaderIdIndex = store.index('previousHeaderId')


    // Get all headers with height <= maxHeight
    const range = IDBKeyRange.upperBound(maxHeight)
    const headerIdsToDelete = await heightIndex.getAll(range)

    const deletedCount = headerIdsToDelete.length

    const headersToUpdate = await previousHeaderIdIndex.getAll(headerIdsToDelete)
    for (const header of headersToUpdate) {
      await store.put({ ...header, previousHeaderId: null })
    }

    // Delete the headers
    for (const headerId of headerIdsToDelete) {
      await store.delete(headerId)
    }

    await trx.done
    return deletedCount
  }

  /**
   * @returns the active chain tip header
   * @throws an error if there is no tip.
   */
  override async findChainTipHeader(): Promise<LiveBlockHeader> {
    const header = await this.findChainTipHeaderOrUndefined()
    if (!header) throw new Error('Database contains no active chain tip header.')
    return header
  }

  /**
   * 
   * @returns the active chain tip header
   * @throws an error if there is no tip.
   */
  override async findChainTipHeaderOrUndefined(): Promise<LiveBlockHeader | undefined> {
    if (!this.db) throw new Error('not initialized')

    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const activeTipIndex = store.index('activeTip')
    const isActiveIndex = store.index('isActive')
    const heightIndex = store.index('height')

    const all0 = await store.getAll()
    const all = await activeTipIndex.getAll()
    const allIsActive = await isActiveIndex.getAll()
    const allHeights = await heightIndex.getAll(1)

    const header = await activeTipIndex.get([1, 1])
    // Repair stored live headers
    if (header) {
      header.isActive = header.isActive === 1
      header.isChainTip = header.isChainTip === 1
    }
    return header
  }

  override findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null> {
    throw new Error('Method not implemented.')
  }
  override findLiveHeaderForHeaderId(headerId: number): Promise<LiveBlockHeader> {
    throw new Error('Method not implemented.')
  }
  override findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null> {
    throw new Error('Method not implemented.')
  }
  override findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null> {
    throw new Error('Method not implemented.')
  }
  override findLiveHeightRange(): Promise<{ minHeight: number; maxHeight: number }> {
    throw new Error('Method not implemented.')
  }
  override findMaxHeaderId(): Promise<number> {
    throw new Error('Method not implemented.')
  }
  override getLiveHeightRange(): Promise<HeightRange> {
    throw new Error('Method not implemented.')
  }
  override liveHeadersForBulk(count: number): Promise<LiveBlockHeader[]> {
    throw new Error('Method not implemented.')
  }
  override getHeaders(height: number, count: number): Promise<number[]> {
    throw new Error('Method not implemented.')
  }
  override insertHeader(header: BlockHeader): Promise<InsertHeaderResult> {
    throw new Error('Method not implemented.')
  }
}

export interface ChaintracksStorageIdbSchema {
  liveHeaders: {
    key: number
    value: LiveBlockHeader
    indexes: {
      hash: string
      previousHash: string
      previousHeaderId: number | null
      isActive: boolean
      activeTip: [boolean, boolean]
      height: number
    }
  }
  bulkHeaders: {
    key: number
    value: BulkHeaderFileInfo
    indexes: {
      firstHeight: number
    }
  }
}