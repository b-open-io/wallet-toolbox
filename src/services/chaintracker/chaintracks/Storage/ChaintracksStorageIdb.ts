import { ChaintracksStorageBaseOptions, ChaintracksStorageBulkFileApi, InsertHeaderResult } from '../Api/ChaintracksStorageApi'
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

export class ChaintracksStorageIdb extends ChaintracksStorageBase implements ChaintracksStorageBulkFileApi {
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

  override async destroy(): Promise<void> {}

  override async deleteLiveBlockHeaders(): Promise<void> {
    await this.makeAvailable( )
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
    await this.makeAvailable( )

    const trx = this.toDbTrxReadWrite(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')
    const previousHeaderIdIndex = store.index('previousHeaderId')


    // Get all headers with height <= maxHeight
    const range = IDBKeyRange.upperBound(maxHeight)
    const headersToDelete: LiveBlockHeader[] = await heightIndex.getAll(range)
    const headerIdsToDelete = new Set(headersToDelete.map(header => header.headerId))
    const deletedCount = headersToDelete.length

    for (const id of headerIdsToDelete) {
      const headerToUpdate = await previousHeaderIdIndex.get(id)
      await store.put({ ...headerToUpdate, previousHeaderId: null })
    }

    // Delete the headers
    for (const id of headerIdsToDelete) {
      await store.delete(id)
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
    await this.makeAvailable( )
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const activeTipIndex = store.index('activeTip')
    const header = await activeTipIndex.get([1, 1])
    this.repairStoredLiveHeader(header)
    await trx.done
    return header
  }

  override async findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null> {
    await this.makeAvailable( )
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const hashIndex = store.index('hash')
    const header = await hashIndex.get(hash)
    this.repairStoredLiveHeader(header)
    await trx.done
    return header
  }

  override async findLiveHeaderForHeaderId(headerId: number): Promise<LiveBlockHeader> {
    await this.makeAvailable( )
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const header = await store.get(headerId)
    this.repairStoredLiveHeader(header)
    await trx.done
    return header
  }

  override async findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null> {
    await this.makeAvailable( )
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')
    const header = await heightIndex.get(height)
    this.repairStoredLiveHeader(header)
    await trx.done
    return header || null
  }

  override async findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null> {
    await this.makeAvailable( )
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const merkleRootIndex = store.index('merkleRoot')
    const header = await merkleRootIndex.get(merkleRoot)
    this.repairStoredLiveHeader(header)
    await trx.done
    return header || null
  }

  override async findLiveHeightRange(): Promise<HeightRange> {
    await this.makeAvailable( )
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')

    const minCursor = await heightIndex.openCursor(null, 'next');
    const minValue = minCursor ? minCursor.value.height : null;

    const maxCursor = await heightIndex.openCursor(null, 'prev');
    const maxValue = maxCursor ? maxCursor.value.height : null;

    const range = (minValue === null || maxValue === null)
      ? HeightRange.empty
      : new HeightRange(minValue, maxValue);

    await trx.done
    return range
  }

  override async findMaxHeaderId(): Promise<number> {
    await this.makeAvailable( )
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')

    const maxCursor = await store.openKeyCursor(null, 'prev');
    const maxValue: number = maxCursor ? Number(maxCursor.key) : 0;
    await trx.done
    return maxValue
  }

  override async liveHeadersForBulk(count: number): Promise<LiveBlockHeader[]> {
    await this.makeAvailable( )

    const trx = this.toDbTrxReadWrite(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')

    let cursor = await heightIndex.openCursor(null, 'next');
    const headers: LiveBlockHeader[] = []

    while (cursor && count > 0) {
      const header = this.repairStoredLiveHeader(cursor.value)
      if (header && header.isActive) {
        count--
        headers.push(header)
      }
      cursor = await cursor.continue()
    }

    await trx.done
    return headers
  }

  override async getLiveHeaders(range: HeightRange): Promise<LiveBlockHeader[]> {
    await this.makeAvailable( )

    const trx = this.toDbTrxReadWrite(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')

    let cursor = await heightIndex.openCursor(null, 'next');
    const headers: LiveBlockHeader[] = []

    while (cursor) {
      const header = this.repairStoredLiveHeader(cursor.value)
      if (header && range.contains(header.headerId)) {
        headers.push(header)
      }
      cursor = await cursor.continue()
    }

    await trx.done
    return headers
  }

  override insertHeader(header: BlockHeader): Promise<InsertHeaderResult> {
    throw new Error('Method not implemented.')
  }

  async deleteBulkFile(fileId: number): Promise<number> {
    throw new Error('Method not implemented.')
  }

  async insertBulkFile(file: BulkHeaderFileInfo): Promise<number> {
    throw new Error('Method not implemented.')
  }
  async updateBulkFile(fileId: number, file: BulkHeaderFileInfo): Promise<number> {
    throw new Error('Method not implemented.')
  }
  async getBulkFiles(): Promise<BulkHeaderFileInfo[]> {
    throw new Error('Method not implemented.')
  }

  async getBulkFileData(fileId: number, offset?: number, length?: number): Promise<Uint8Array | undefined> {
    throw new Error('Method not implemented.')
  }

  /**
   * IndexedDB does not do indices of boolean properties.
   * So true is stored as a 1, and false is stored as no property value (delete v['property'])
   * 
   * This function restores these property values to true and false.
   * 
   * @param header
   * @returns copy of header with updated properties
   */
  private repairStoredLiveHeader(header?: LiveBlockHeader): LiveBlockHeader | undefined {
    if (!header) return undefined
    const h: LiveBlockHeader = {
      ...header,
      isActive: !!header['isActive'],
      isChainTip: !!header['isChainTip']
    }
    return h
  }

  private prepareStoredLiveHeader(header: LiveBlockHeader, forInsert?: boolean) : object {
    const h: object = {...header}
    if (forInsert)
      delete h['headerId'];

    if (header.isActive) h['isActive'] = 1; else delete h['isActive'];
    if (header.isChainTip) h['isChainTip'] = 1; else delete h['isChainTip'];

    return h
  }

  async insertLiveHeader(header: LiveBlockHeader): Promise<LiveBlockHeader> {
    
    const trx = this.toDbTrxReadWrite(['live_headers'])
    const store = trx.objectStore('live_headers')
    
    const h = this.prepareStoredLiveHeader(header, true)

    header.headerId = Number(await store.add(h))
    
    await trx.done

    return header
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
          liveHeadersStore.createIndex('previousHeaderId', 'previousHeaderId', { unique: false })
          liveHeadersStore.createIndex('height', 'height', { unique: false })
          liveHeadersStore.createIndex('merkleRoot', 'merkleRoot', { unique: false })
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