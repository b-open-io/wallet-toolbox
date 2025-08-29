import 'fake-indexeddb/auto'
import { ChaintracksFs } from '../../util/ChaintracksFs'
import { Chain } from '../../../../../sdk'
import { ChaintracksStorageKnex } from '../ChaintracksStorageKnex'
import { deserializeBaseBlockHeader, genesisHeader } from '../../util/blockHeaderUtilities'
import { ChaintracksStorageIdb, ChaintracksStorageIdbOptions } from '../ChaintracksStorageIdb'
import { ChaintracksStorageBase } from '../ChaintracksStorageBase'
import { LiveBlockHeader } from '../../Api/BlockHeaderApi'

describe('ChaintracksStorageIdb tests', () => {
  jest.setTimeout(99999999)

  test('0', async () => {
    const options: ChaintracksStorageIdbOptions = ChaintracksStorageBase.createStorageBaseOptions('main')
    const storage = new ChaintracksStorageIdb(options)
    const r = await storage.migrateLatest()
    const db = storage.db!
    expect(db).toBeTruthy()

    const tip = await storage.findChainTipHeaderOrUndefined()
    expect(tip).toBeUndefined()

    const lh: LiveBlockHeader = {
      headerId: 0,
      chainWork: '00'.repeat(32),
      isChainTip: true,
      isActive: true,
      previousHeaderId: null,
      height: 1,
      hash: '1234',
      version: 0,
      previousHash: '00'.repeat(32),
      merkleRoot: '00'.repeat(32),
      time: 0,
      bits: 0,
      nonce: 0
    }
    await insertLive(storage, lh)

    // Debug index keys
  const trx = storage.toDbTrxReadOnly(['live_headers']);
  const store = trx.objectStore('live_headers');
  const isActiveIndex = store.index('isActive');
  let cursor = await isActiveIndex.openKeyCursor();
  if (cursor) {
    do {
      console.log('isActive index key:', cursor.key, 'Primary key:', cursor.primaryKey);
      cursor = await cursor.continue();
    } while (cursor);
  } else {
    console.log('No keys found in isActive index');
  }

    const tip2 = await storage.findChainTipHeader()
    expect(tip2.headerId).toBe(1)
  })
})

async function insertLive(storage: ChaintracksStorageIdb, header: LiveBlockHeader): Promise<LiveBlockHeader> {
  
  const trx = storage.toDbTrxReadWrite(['live_headers'])
  const store = trx.objectStore('live_headers')
  
  const h: object = {...header}
  delete h['headerId']

  if (header.isActive) h['isActive'] = 1; else delete h['isActive'];
  if (header.isChainTip) h['isChainTip'] = 1; else delete h['isChainTip'];

  header.headerId = Number(await store.add(h))
  
  await trx.done
  return header as LiveBlockHeader
}