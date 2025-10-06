import { Chain } from '../../../sdk'
import { ChaintracksOptions } from './Api/ChaintracksApi'
import { Chaintracks } from './Chaintracks'
import { BulkIngestorCDNBabbage } from './Ingest/BulkIngestorCDNBabbage'
import { ChaintracksFetch } from './util/ChaintracksFetch'
import { LiveIngestorWhatsOnChainOptions, LiveIngestorWhatsOnChainPoll } from './Ingest/LiveIngestorWhatsOnChainPoll'
import { BulkIngestorWhatsOnChainCdn, BulkIngestorWhatsOnChainOptions } from './Ingest/BulkIngestorWhatsOnChainCdn'
import { ChaintracksFetchApi } from './Api/ChaintracksFetchApi'
import { ChaintracksStorageIdb, ChaintracksStorageIdbOptions } from './Storage/ChaintracksStorageIdb'
import { BulkFileDataManager, BulkFileDataManagerOptions } from './util/BulkFileDataManager'
import { BulkIngestorCDNOptions } from './Ingest/BulkIngestorCDN'
import { WhatsOnChainServicesOptions } from './Ingest/WhatsOnChainServices'

export function createDefaultIdbChaintracksOptions(
  chain: Chain,
  whatsonchainApiKey: string = '',
  maxPerFile: number = 100000,
  maxRetained: number = 2,
  fetch?: ChaintracksFetchApi,
  cdnUrl: string = 'https://cdn.projectbabbage.com/blockheaders/',
  liveHeightThreshold: number = 2000,
  reorgHeightThreshold: number = 400,
  bulkMigrationChunkSize: number = 500,
  batchInsertLimit: number = 400,
  addLiveRecursionLimit: number = 36
): ChaintracksOptions {
  fetch ||= new ChaintracksFetch()

  const bfo: BulkFileDataManagerOptions = {
    chain,
    fetch,
    maxPerFile,
    maxRetained,
    fromKnownSourceUrl: cdnUrl
  }
  const bulkFileDataManager = new BulkFileDataManager(bfo)

  const so: ChaintracksStorageIdbOptions = {
    chain,
    bulkFileDataManager,
    liveHeightThreshold,
    reorgHeightThreshold,
    bulkMigrationChunkSize,
    batchInsertLimit
  }
  const storage = new ChaintracksStorageIdb(so)

  const co: ChaintracksOptions = {
    chain,
    storage,
    bulkIngestors: [],
    liveIngestors: [],
    addLiveRecursionLimit,
    logging: (...args) => console.log(new Date().toISOString(), ...args),
    readonly: false
  }

  const jsonResource = `${chain}NetBlockHeaders.json`

  const bulkCdnOptions: BulkIngestorCDNOptions = {
    chain,
    jsonResource,
    fetch,
    cdnUrl,
    maxPerFile
  }
  co.bulkIngestors.push(new BulkIngestorCDNBabbage(bulkCdnOptions))

  const wocOptions: WhatsOnChainServicesOptions = {
    chain,
    apiKey: whatsonchainApiKey,
    timeout: 30000,
    userAgent: 'BabbageWhatsOnChainServices',
    enableCache: true,
    chainInfoMsecs: 5000
  }

  const bulkOptions: BulkIngestorWhatsOnChainOptions = {
    ...wocOptions,
    jsonResource,
    idleWait: 5000
  }
  co.bulkIngestors.push(new BulkIngestorWhatsOnChainCdn(bulkOptions))

  const liveOptions: LiveIngestorWhatsOnChainOptions = {
    ...wocOptions,
    idleWait: 100000
  }
  co.liveIngestors.push(new LiveIngestorWhatsOnChainPoll(liveOptions))

  return co
}
