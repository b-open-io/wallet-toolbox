import { WalletError } from "../WalletError"
import { WalletErrorFromJson } from "../WalletErrorFromJson"
import { WERR_REVIEW_ACTIONS } from "../WERR_errors"

describe('WalletError tests', () => {
    jest.setTimeout(99999999)

    test('0', async () => {
       const werr = new WERR_REVIEW_ACTIONS([], [], 'txid123', undefined, [])

       const json = werr.toJson()
       const obj = JSON.parse(json)
       expect(obj.name).toBe('WERR_REVIEW_ACTIONS')
       const werr2 = WalletErrorFromJson(obj)

       expect(werr2 instanceof WERR_REVIEW_ACTIONS).toBe(true)
       const werr3 = werr2 as WERR_REVIEW_ACTIONS
       expect(werr3.txid).toBe('txid123')
    })
})