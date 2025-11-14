import { WalletLoggerInterface } from '@bsv/sdk'
import { WalletError } from './sdk/WalletError'

export class WalletLogger implements WalletLoggerInterface {
  indent: number = 0
  logs: WalletLoggerLog[] = []
  isOrigin: boolean = true
  isError: boolean = false

  constructor(log?: string) {
    if (log) {
      const lo = JSON.parse(log)
      this.indent = lo.indent || 0
      this.logs = lo.logs || []
      this.isOrigin = false
    }
  }

  private logAny(message?: any): string {
    if (!message) return ''
    if (typeof message === 'string') return message
    if (typeof message === 'object') return JSON.stringify(message)
    return ''
  }

  private toAdd(
    isBegin: boolean,
    isEnd: boolean,
    isError: boolean,
    message?: any,
    optionalParams?: any[]
  ): WalletLoggerLog {
    let add = ''
    if (message) add += this.logAny(message)
    if (optionalParams) for (const p of optionalParams) add += this.logAny(p)
    let log = {
      when: Date.now(),
      indent: this.indent,
      isBegin,
      isEnd,
      isError,
      log: add
    }
    return log
  }

  private stampLog(isBegin: boolean, isEnd: boolean, isError: boolean, message?: any, optionalParams?: any[]) {
    const add = this.toAdd(isBegin, isEnd, isError, message, optionalParams)
    this.logs.push(add)
  }

  group(...label: any[]): void {
    this.stampLog(true, false, false, undefined, label)
    this.indent++
  }

  groupEnd(): void {
    this.indent--
    if (this.indent < 0) this.indent = 0
    this.stampLog(false, true, false)
  }

  log(message?: any, ...optionalParams: any[]): void {
    this.stampLog(false, false, false, message, optionalParams)
  }
  error(message?: any, ...optionalParams: any[]): void {
    this.stampLog(false, false, true, message, optionalParams)
    this.isError = true
  }

  toWalletLoggerJson(): object {
    const json: object = {
      isWalletLoggerJson: true,
      indent: this.indent,
      logs: this.logs,
      isError: this.isError
    }
    return json
  }

  toLogString(): string {
    let log = ''
    if (this.logs.length > 0) {
      const first = this.logs[0]
      const last = this.logs.slice(-1)[0]
      const msecs = last.when - first.when
      log += `   msecs WalletLogger ${new Date(first.when).toISOString()} logged ${msecs / 1000} seconds\n`
      let prev = first
      let lastBegin: WalletLoggerLog | undefined
      for (const d of this.logs) {
        let df = (d.when - prev.when).toString()
        df = `${' '.repeat(8 - df.length)}${df}`
        const what = d.isBegin ? ' begin' : d.isEnd ? ' end' : d.isError ? ' ERROR' : ''
        if (d.isBegin) lastBegin = d
        let m = d.log
        if (!m && d.isEnd && lastBegin) m = lastBegin.log
        log += `${df}${'  '.repeat(d.indent)}${what} ${m}\n`
        prev = d
      }
    }
    return log
  }

  flush(): object | undefined {
    const log = this.toLogString()
    if (this.isError) console.error(log)
    else console.log(log)
    const r = this.isOrigin ? undefined : this.toWalletLoggerJson()
    return r
  }
}

export function logWalletError(eu: unknown, logger?: WalletLoggerInterface): void {
  if (!logger) return
  logger.error('WalletError:', WalletError.unknownToJson(eu))
}

export interface WalletLoggerLog {
  when: number
  indent: number
  log: string
  isError?: boolean
  isBegin?: boolean
  isEnd?: boolean
}