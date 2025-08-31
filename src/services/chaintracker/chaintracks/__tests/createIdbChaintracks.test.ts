import { _tu } from "../../../../../test/utils/TestUtilsWalletStorage"
import { wait } from "../../../../utility/utilityHelpers"
import { createdIdbChaintracks } from "../createIdbChaintracks"

import 'fake-indexeddb/auto'
import { BulkFileDataManager } from "../util/BulkFileDataManager"
import { BulkHeaderFileInfo } from "../util/BulkHeaderFile"
import { HeaderListener } from "../Api/ChaintracksClientApi"
import { BlockHeader } from "../index.client"

describe('createIdbChaintracks tests', () => {
    jest.setTimeout(99999999)

    test('0', async () => {
      const env = _tu.getEnv('main')
      const { chain, chaintracks, storage } = await createdIdbChaintracks(
        env.chain,
        env.whatsonchainApiKey,
      )
      const headerListener: HeaderListener = (header: BlockHeader) => {
        console.log(`headerListener: height: ${header.height} hash: ${header.hash} ${new Date().toISOString()}`)
      }
      chaintracks.subscribeHeaders(headerListener)
      const tip = await chaintracks.findChainTipHeader()
      chaintracks.log(`tip: height: ${tip.height} hash: ${tip.hash}`)
      expect(countDatas(storage.bulkManager)).toBe(3)
      for (;;)
        await wait(120000)
    })
})

function countDatas(manager: BulkFileDataManager): number {
  let count = 0
  for (const file of manager['bfds'] as BulkHeaderFileInfo[]) {
    if (file.data) count += 1
  }
  return count
}